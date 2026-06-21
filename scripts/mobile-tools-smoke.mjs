import { chromium } from "playwright";

const targetUrl = process.env.POCODEX_SMOKE_URL ?? "http://127.0.0.1:8787/";
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const browser = await chromium.launch({
  headless: true,
  executablePath: chromePath,
});

try {
  const results = [];

  results.push(await openToolAndAssert("Files", assertFilesPanel));
  results.push(await openToolAndAssert("Browser", assertBrowserPanel));
  results.push(await openToolAndAssert("Terminal", assertTerminalPanel));

  console.log(
    JSON.stringify(
      {
        ok: true,
        url: targetUrl,
        tools: results,
      },
      null,
      2,
    ),
  );
} finally {
  await closeBrowser(browser);
}

async function openToolAndAssert(toolName, assertPanel) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();

  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 45_000 });

    const marker = `${toolName.toUpperCase()}_${Math.random().toString(36).slice(2, 10)}`;
    await typePrompt(page, `Reply exactly: ${marker}`);
    await clickComposerSend(page);
    await page.waitForFunction(
      (expectedMarker) => document.body.innerText.split(expectedMarker).length > 2,
      marker,
      { timeout: 120_000 },
    );

    await page.getByRole("button", { name: "Toggle side panel" }).click({ force: true });
    await waitForRightPanelGeometry(page);
    await assertMobilePanelsAreMutuallyExclusive(page);
    await clickVisibleButtonStartingWith(page, toolName);

    await assertPanel(page);
    await assertRightPanelGeometry(page);

    return { tool: toolName, marker };
  } catch (error) {
    const snapshot = await captureSnapshot(page);
    throw new Error(`${toolName} mobile tool smoke failed.\n${snapshot}`, { cause: error });
  } finally {
    await closeContext(context);
  }
}

async function assertFilesPanel(page) {
  await waitForBodyText(page, /Open file[\s\S]*Filter files/, "Files panel did not render");
  await page.getByPlaceholder(/Filter files/).waitFor({ state: "visible", timeout: 20_000 });
}

async function assertBrowserPanel(page) {
  await waitForBodyText(page, /New tab/, "Browser panel did not render");
  await page.getByPlaceholder("Enter a URL").waitFor({ state: "visible", timeout: 20_000 });
}

async function assertTerminalPanel(page) {
  await page.getByLabel("Terminal input").waitFor({ state: "visible", timeout: 30_000 });

  const terminalMarker = `TERM_${Math.random().toString(36).slice(2, 10)}`;
  await page.getByLabel("Terminal input").last().click({ force: true });
  await page.keyboard.insertText(`printf '${terminalMarker}\\n'`);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (expectedMarker) => document.body.innerText.includes(expectedMarker),
    terminalMarker,
    {
      timeout: 30_000,
    },
  );
}

async function waitForRightPanelGeometry(page) {
  await page.waitForFunction(
    () => document.documentElement.dataset.pocodexMobileRightPanel === "open",
    { timeout: 10_000 },
  );
  await assertRightPanelGeometry(page);
}

async function assertRightPanelGeometry(page) {
  const geometry = await page.evaluate(() => {
    const panel = document.querySelector('[data-pocodex-mobile-right-panel-root="true"]');
    const mainSurface = document.querySelector(".main-surface");
    const panelRect = panel instanceof Element ? panel.getBoundingClientRect() : null;
    const mainRect = mainSurface instanceof Element ? mainSurface.getBoundingClientRect() : null;

    return {
      state: document.documentElement.dataset.pocodexMobileRightPanel ?? null,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      panel: panelRect
        ? {
            left: panelRect.left,
            right: panelRect.right,
            top: panelRect.top,
            bottom: panelRect.bottom,
            width: panelRect.width,
            height: panelRect.height,
          }
        : null,
      main: mainRect
        ? {
            left: mainRect.left,
            right: mainRect.right,
            width: mainRect.width,
          }
        : null,
    };
  });

  assert(geometry.state === "open", `right panel state is not open: ${JSON.stringify(geometry)}`);
  assert(geometry.panel, `right panel root was not tagged: ${JSON.stringify(geometry)}`);
  assert(geometry.main, `main surface is missing: ${JSON.stringify(geometry)}`);

  const tolerance = 2;
  assert(
    geometry.panel.width <= geometry.viewport.width * 0.92 + tolerance,
    `right panel is too wide: ${JSON.stringify(geometry)}`,
  );
  assert(
    geometry.panel.left >= -tolerance,
    `right panel overflows left viewport edge: ${JSON.stringify(geometry)}`,
  );
  assert(
    geometry.panel.right <= geometry.viewport.width + tolerance,
    `right panel overflows right viewport edge: ${JSON.stringify(geometry)}`,
  );
  assert(
    geometry.panel.height >= geometry.viewport.height * 0.5,
    `right panel is not tall enough to behave as an overlay: ${JSON.stringify(geometry)}`,
  );
  assert(
    geometry.main.width >= geometry.viewport.width - tolerance,
    `main surface was squeezed by right panel: ${JSON.stringify(geometry)}`,
  );
}

async function assertMobilePanelsAreMutuallyExclusive(page) {
  const state = await page.evaluate(() => {
    const leftPanel = document.querySelector(".app-shell-left-panel");
    const leftRect = leftPanel instanceof Element ? leftPanel.getBoundingClientRect() : null;
    const isLeftVisible = Boolean(
      leftRect &&
      leftRect.width > 0 &&
      leftRect.height > 0 &&
      leftRect.right > 0 &&
      leftRect.left < window.innerWidth,
    );

    return {
      leftDataset: document.documentElement.dataset.pocodexMobileSidebar ?? null,
      rightDataset: document.documentElement.dataset.pocodexMobileRightPanel ?? null,
      isLeftVisible,
      isRightOpen: document.documentElement.dataset.pocodexMobileRightPanel === "open",
    };
  });

  assert(
    !(state.isLeftVisible && state.isRightOpen),
    `left and right mobile panels are visible together: ${JSON.stringify(state)}`,
  );
}

async function typePrompt(page, prompt) {
  const editor = page.locator('textarea, [contenteditable="true"]').last();
  await editor.click();
  await page.keyboard.insertText(prompt);
}

async function clickComposerSend(page) {
  await page.locator("button.bg-token-foreground").last().click();
}

async function clickVisibleButtonStartingWith(page, text) {
  await page.waitForFunction(
    (expectedText) => {
      for (const candidate of document.querySelectorAll("button")) {
        const label = candidate.textContent?.trim().replace(/\s+/g, "") ?? "";
        const rect = candidate.getBoundingClientRect();
        const style = window.getComputedStyle(candidate);
        const isVisible =
          rect.width > 0 &&
          rect.height > 0 &&
          rect.right > 0 &&
          rect.left < window.innerWidth &&
          rect.bottom > 0 &&
          rect.top < window.innerHeight &&
          style.display !== "none" &&
          style.visibility !== "hidden";
        if (isVisible && label.startsWith(String(expectedText))) {
          return true;
        }
      }
      return false;
    },
    text,
    { timeout: 15_000 },
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const button = page
      .locator("button")
      .filter({ hasText: new RegExp(`^${text}`) })
      .last();
    await button.click({ force: true, timeout: 5_000 }).catch(async () => {
      const point = await page.evaluate((expectedText) => {
        const button = findVisibleButtonStartingWith(String(expectedText));
        if (!button) {
          return null;
        }
        const rect = button.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };

        function findVisibleButtonStartingWith(expectedText) {
          for (const candidate of document.querySelectorAll("button")) {
            const label = candidate.textContent?.trim().replace(/\s+/g, "") ?? "";
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            const isVisible =
              rect.width > 0 &&
              rect.height > 0 &&
              rect.right > 0 &&
              rect.left < window.innerWidth &&
              rect.bottom > 0 &&
              rect.top < window.innerHeight &&
              style.display !== "none" &&
              style.visibility !== "hidden";
            if (isVisible && label.startsWith(expectedText)) {
              return candidate;
            }
          }
          return null;
        }
      }, text);
      if (!point) {
        throw new Error(`Visible ${text} button disappeared before click.`);
      }
      await page.mouse.click(point.x, point.y);
    });

    await page.waitForTimeout(500);
    const isStillChooser = await page.evaluate(
      () =>
        document.body.innerText.includes("Side chat") &&
        document.body.innerText.includes("Browser") &&
        document.body.innerText.includes("Terminal"),
    );
    if (!isStillChooser) {
      return;
    }

    await page.evaluate((expectedText) => {
      const button = findVisibleButtonStartingWith(String(expectedText));
      button?.click();

      function findVisibleButtonStartingWith(expectedText) {
        for (const candidate of document.querySelectorAll("button")) {
          const label = candidate.textContent?.trim().replace(/\s+/g, "") ?? "";
          const rect = candidate.getBoundingClientRect();
          const style = window.getComputedStyle(candidate);
          const isVisible =
            rect.width > 0 &&
            rect.height > 0 &&
            rect.right > 0 &&
            rect.left < window.innerWidth &&
            rect.bottom > 0 &&
            rect.top < window.innerHeight &&
            style.display !== "none" &&
            style.visibility !== "hidden";
          if (isVisible && label.startsWith(expectedText)) {
            return candidate;
          }
        }
        return null;
      }
    }, text);
    await page.waitForTimeout(500);
  }
}

async function waitForBodyText(page, pattern, message) {
  try {
    await page.waitForFunction(
      (source) => new RegExp(source).test(document.body.innerText),
      pattern.source,
      { timeout: 20_000 },
    );
  } catch (error) {
    const tail = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    throw new Error(`${message}\n\nPage tail:\n${tail.slice(-2_000)}`, { cause: error });
  }
}

async function captureSnapshot(page) {
  const snapshot = await page
    .evaluate(() => ({
      bodyText: document.body.innerText.slice(0, 2_000),
      debug: window.__pocodexDebug?.snapshot?.(),
    }))
    .catch((error) => ({
      error: String(error),
    }));

  return JSON.stringify(snapshot, null, 2);
}

async function closeBrowser(browser) {
  const browserProcess = browser.process?.();
  const timeout = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error("Timed out while closing Playwright browser"));
    }, 5_000);
  });

  try {
    await Promise.race([browser.close(), timeout]);
  } catch {
    browserProcess?.kill("SIGKILL");
  }
}

async function closeContext(context) {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error("Timed out while closing Playwright context"));
    }, 5_000);
  });

  await Promise.race([context.close(), timeout]).catch(() => {});
}
