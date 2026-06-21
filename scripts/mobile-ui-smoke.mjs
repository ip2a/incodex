import { chromium } from "playwright";

const targetUrl = process.env.POCODEX_SMOKE_URL ?? "http://127.0.0.1:8787/?pocodexDebug=1";
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

  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 45_000 });

  const initialDebug = await page.evaluate(() => window.__pocodexDebug?.snapshot?.());
  assert(initialDebug?.connectionPhase === "connected", "browser bridge is not connected");
  assert(initialDebug?.socketReadyState === "OPEN", "websocket is not open");

  const initialSidebarOpen = await isSidebarOpen(page);
  if (initialSidebarOpen) {
    await clickMainSurface(page);
    await waitForSidebarState(page, false);
    await assertSidebarHoverDoesNotOpen(page);
    await clickSidebarToggle(page);
    await waitForSidebarState(page, true);
    await assertSidebarRemainsExpanded(page);
  } else {
    await assertSidebarHoverDoesNotOpen(page);
    await clickSidebarToggle(page);
    await waitForSidebarState(page, true);
    await assertSidebarRemainsExpanded(page);
    await clickMainSurface(page);
    await waitForSidebarState(page, false);
  }

  await ensureSidebarOpen(page);
  await page.getByRole("button", { name: "Settings" }).first().click();
  await waitForBodyText(
    page,
    /Settings[\s\S]*Log out|Logged in with API key/,
    "settings menu did not open",
  );
  await page.keyboard.press("Escape");

  await ensureSidebarOpen(page);
  const addProjectButton = page.getByRole("button", { name: "Add new project" });
  await addProjectButton.hover();
  await addProjectButton.click({ force: true });
  await page.getByRole("menuitem", { name: "Start from scratch" }).waitFor({
    state: "visible",
    timeout: 10_000,
  });
  await page.getByRole("menuitem", { name: "Use an existing folder" }).click({ force: true });
  await page
    .locator('[data-pocodex-workspace-root-picker-dialog="true"]')
    .waitFor({ state: "visible", timeout: 20_000 });
  await waitForBodyText(
    page,
    /Add a project folder[\s\S]*Folder path[\s\S]*Use folder/,
    "folder picker did not render",
  );
  await page.getByRole("button", { name: "Cancel" }).click();
  await page
    .locator('[data-pocodex-workspace-root-picker-dialog="true"]')
    .waitFor({ state: "hidden", timeout: 10_000 });

  const finalDebug = await page.evaluate(() => window.__pocodexDebug?.snapshot?.());
  assert(
    finalDebug?.connectionPhase === "connected",
    "browser bridge disconnected during UI smoke",
  );
  assert(finalDebug?.pendingMessages === 0, "browser has queued messages after UI smoke");

  console.log(
    JSON.stringify(
      {
        ok: true,
        url: targetUrl,
        sidebarInitialState: initialSidebarOpen ? "open" : "closed",
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}

async function clickSidebarToggle(page) {
  await page
    .locator('button[aria-label="Hide sidebar"], button[aria-label="Show sidebar"]')
    .first()
    .click({ force: true });
}

async function clickMainSurface(page) {
  const surface = page.locator(".main-surface").first();
  const box = await surface.boundingBox();
  if (!box) {
    throw new Error("main surface is not visible");
  }

  await page.mouse.click(box.x + box.width - 24, box.y + Math.min(box.height - 24, 180));
}

async function assertSidebarHoverDoesNotOpen(page) {
  const toggle = page
    .locator('button[aria-label="Hide sidebar"], button[aria-label="Show sidebar"]')
    .first();
  const box = await toggle.boundingBox();
  if (!box) {
    throw new Error("sidebar toggle is not visible");
  }

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(350);
  assert(!(await isSidebarOpen(page)), "sidebar opened from hover without a click");
}

async function ensureSidebarOpen(page) {
  if (await isSidebarOpen(page)) {
    return;
  }

  await clickSidebarToggle(page);
  await waitForSidebarState(page, true);
}

async function isSidebarOpen(page) {
  return await page.evaluate(() => {
    const navigation = document.querySelector('nav[role="navigation"]');
    if (
      !(navigation instanceof Element) ||
      typeof navigation.getBoundingClientRect !== "function"
    ) {
      return false;
    }

    const rect = navigation.getBoundingClientRect();
    return rect.left >= -0.5 && rect.right > 0.5 && rect.width > 0.5;
  });
}

async function waitForSidebarState(page, expectedOpen) {
  await page.waitForFunction(
    (open) => {
      const navigation = document.querySelector('nav[role="navigation"]');
      if (
        !(navigation instanceof Element) ||
        typeof navigation.getBoundingClientRect !== "function"
      ) {
        return false;
      }

      const rect = navigation.getBoundingClientRect();
      const isOpen = rect.left >= -0.5 && rect.right > 0.5 && rect.width > 0.5;
      return isOpen === open;
    },
    expectedOpen,
    { timeout: 10_000 },
  );
}

async function assertSidebarRemainsExpanded(page) {
  await page.waitForTimeout(1_200);

  const geometry = await page.evaluate(() => {
    const navigation = document.querySelector('nav[role="navigation"]');
    const shell = document.querySelector(".app-shell-left-panel");
    const mobileState = document.documentElement.dataset.pocodexMobileSidebar ?? null;
    const readRect = (element) => {
      if (!(element instanceof Element) || typeof element.getBoundingClientRect !== "function") {
        return null;
      }
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        width: rect.width,
      };
    };

    return {
      mobileState,
      navigation: readRect(navigation),
      shell: readRect(shell),
      viewportWidth: window.innerWidth,
    };
  });

  const navigationWidth = geometry.navigation?.width ?? 0;
  const shellWidth = geometry.shell?.width ?? 0;
  const minimumExpandedWidth = Math.min(220, Math.max(180, geometry.viewportWidth * 0.45));

  assert(
    geometry.mobileState === "open",
    `mobile sidebar overlay state changed unexpectedly: ${geometry.mobileState}`,
  );
  assert(
    navigationWidth >= minimumExpandedWidth || shellWidth >= minimumExpandedWidth,
    `mobile sidebar collapsed into a narrow rail after opening: ${JSON.stringify(geometry)}`,
  );
}

async function waitForBodyText(page, pattern, message) {
  try {
    await page.waitForFunction(
      (source) => new RegExp(source).test(document.body.innerText),
      pattern.source,
      { timeout: 10_000 },
    );
  } catch (error) {
    const tail = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    throw new Error(`${message}\n\nPage tail:\n${tail.slice(-2_000)}`, { cause: error });
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
