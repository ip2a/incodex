import { chromium } from "playwright";

const targetUrl = process.env.POCODEX_SMOKE_URL ?? "http://127.0.0.1:8787/";
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const browser = await chromium.launch({
  headless: true,
  executablePath: chromePath,
});

try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__pocodexSmokeIsVisibleElement = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > 0 &&
        rect.left < window.innerWidth &&
        rect.bottom > 0 &&
        rect.top < window.innerHeight &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    };
    window.__pocodexSmokeFindChooserContainer = (element) => {
      let current = element.parentElement;
      for (let depth = 0; current && depth < 8; depth += 1) {
        const text = current.textContent?.replace(/\s+/g, "") ?? "";
        if (text.includes("Files") && text.includes("Browser") && text.includes("Terminal")) {
          return current;
        }
        current = current.parentElement;
      }
      return null;
    };
    window.__pocodexSmokeFindVisibleChooserButtonStartingWith = (expectedText) => {
      const visibleButtons = Array.from(document.querySelectorAll("button")).filter((candidate) => {
        const label = candidate.textContent?.trim().replace(/\s+/g, "") ?? "";
        return label.startsWith(expectedText) && window.__pocodexSmokeIsVisibleElement(candidate);
      });
      return (
        visibleButtons.find((candidate) => window.__pocodexSmokeFindChooserContainer(candidate)) ??
        null
      );
    };
  });

  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 45_000 });

    const marker = `SWITCH_${Math.random().toString(36).slice(2, 10)}`;
    await typePrompt(page, `Reply exactly: ${marker}`);
    await clickComposerSend(page);
    await page.waitForFunction(
      (expectedMarker) => document.body.innerText.split(expectedMarker).length > 2,
      marker,
      { timeout: 120_000 },
    );

    await page.getByRole("button", { name: "Toggle side panel" }).click({ force: true });
    await clickVisibleChooserButtonStartingWith(page, "Files");
    await page.getByPlaceholder(/Filter files/).waitFor({ state: "visible", timeout: 20_000 });

    await openSidePanelTabMenu(page);
    await clickVisibleMenuItemStartingWith(page, "Browser");
    await page.getByPlaceholder("Enter a URL").waitFor({ state: "visible", timeout: 20_000 });

    await openSidePanelTabMenu(page);
    await clickVisibleMenuItemStartingWith(page, "Terminal");
    await page.getByLabel("Terminal input").waitFor({ state: "visible", timeout: 30_000 });

    const terminalMarker = `SWITCHTERM_${Math.random().toString(36).slice(2, 10)}`;
    await page.getByLabel("Terminal input").last().click({ force: true });
    await page.keyboard.insertText(`printf '${terminalMarker}\\n'`);
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (expectedMarker) => document.body.innerText.includes(expectedMarker),
      terminalMarker,
      { timeout: 30_000 },
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          url: targetUrl,
          marker,
          terminalMarker,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    const snapshot = await captureSnapshot(page);
    throw new Error(`Mobile tool switch smoke failed.\n${snapshot}`, { cause: error });
  } finally {
    await closeContext(context);
  }
} finally {
  await closeBrowser(browser);
}

async function openSidePanelTabMenu(page) {
  await clickVisibleTitleButton(page, "Open side panel tab");
  await page.waitForFunction(
    () => {
      for (const item of document.querySelectorAll('[role="menuitem"]')) {
        if (window.__pocodexSmokeIsVisibleElement(item)) {
          return true;
        }
      }
      return false;
    },
    null,
    { timeout: 15_000 },
  );
}

async function clickVisibleChooserButtonStartingWith(page, text) {
  await page.waitForFunction(
    (expectedText) =>
      window.__pocodexSmokeFindVisibleChooserButtonStartingWith(String(expectedText)) !== null,
    text,
    { timeout: 15_000 },
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const point = await page.evaluate((expectedText) => {
      const button = window.__pocodexSmokeFindVisibleChooserButtonStartingWith(
        String(expectedText),
      );
      if (!button) {
        return null;
      }
      const rect = button.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    }, text);

    if (!point) {
      if (await isToolPanelOpen(page, text)) {
        return;
      }
      throw new Error(`Visible ${text} button disappeared before click.`);
    }

    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(500);
    if (await isToolPanelOpen(page, text)) {
      return;
    }

    const isStillChooser = await page.evaluate(
      (expectedText) =>
        window.__pocodexSmokeFindVisibleChooserButtonStartingWith(String(expectedText)) !== null,
      text,
    );
    if (!isStillChooser) {
      return;
    }

    await page.evaluate((expectedText) => {
      window.__pocodexSmokeFindVisibleChooserButtonStartingWith(String(expectedText))?.click();
    }, text);
    await page.waitForTimeout(500);
  }
}

async function isToolPanelOpen(page, text) {
  if (text === "Files") {
    return page
      .getByPlaceholder(/Filter files/)
      .isVisible()
      .catch(() => false);
  }
  if (text === "Browser") {
    return page
      .getByPlaceholder("Enter a URL")
      .isVisible()
      .catch(() => false);
  }
  if (text === "Terminal") {
    return page
      .getByLabel("Terminal input")
      .isVisible()
      .catch(() => false);
  }
  return false;
}

async function clickVisibleTitleButton(page, title) {
  await page.waitForFunction(
    (expectedTitle) => {
      for (const button of document.querySelectorAll("button")) {
        if (
          button.getAttribute("title") !== String(expectedTitle) ||
          !window.__pocodexSmokeIsVisibleElement(button)
        ) {
          continue;
        }
        button.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            pointerType: "mouse",
          }),
        );
        button.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            cancelable: true,
            pointerType: "mouse",
          }),
        );
        button.click();
        return true;
      }
      return false;
    },
    title,
    { timeout: 15_000 },
  );
}

async function clickVisibleMenuItemStartingWith(page, text) {
  const pointHandle = await page.waitForFunction(
    (expectedText) => {
      for (const item of document.querySelectorAll('[role="menuitem"]')) {
        const label = item.textContent?.trim().replace(/\s+/g, "") ?? "";
        if (
          !label.startsWith(String(expectedText)) ||
          !window.__pocodexSmokeIsVisibleElement(item)
        ) {
          continue;
        }
        const rect = item.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      }
      return null;
    },
    text,
    { timeout: 15_000 },
  );
  const point = await pointHandle.jsonValue();
  await page.mouse.click(point.x, point.y);
}

async function typePrompt(page, prompt) {
  const editor = page.locator('textarea, [contenteditable="true"]').last();
  await editor.click();
  await page.keyboard.insertText(prompt);
}

async function clickComposerSend(page) {
  await page.locator("button.bg-token-foreground").last().click();
}

async function captureSnapshot(page) {
  const snapshot = await page
    .evaluate(() => ({
      bodyText: document.body.innerText.slice(0, 2_000),
      debug: window.__pocodexDebug?.snapshot?.(),
      route: window.location.pathname,
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
