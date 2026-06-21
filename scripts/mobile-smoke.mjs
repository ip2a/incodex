import { writeFileSync } from "node:fs";
import { basename } from "node:path";

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
  await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 30_000 });

  const initial = await page.evaluate(() => ({
    bodyText: document.body.innerText,
    debug: window.__pocodexDebug?.snapshot?.(),
    main: document.querySelector(".main-surface")?.getBoundingClientRect().toJSON(),
    nav: document.querySelector('nav[role="navigation"]')?.getBoundingClientRect().toJSON(),
  }));
  assert(initial.bodyText.includes("What should we work on?"), "home composer did not render");
  assert(initial.debug?.connectionPhase === "connected", "browser bridge is not connected");
  assert(initial.debug?.socketReadyState === "OPEN", "websocket is not open");
  assert(initial.debug?.pendingMessages === 0, "browser has queued messages");
  assert(Number(initial.main?.width ?? 0) >= 360, "mobile main pane is too narrow");

  const plainMarker = `SMOKE_${Math.random().toString(36).slice(2, 10)}`;
  await typePrompt(page, `Reply exactly: ${plainMarker}`);
  await clickComposerSend(page);
  await page.waitForFunction(
    (marker) => document.body.innerText.split(marker).length > 2,
    plainMarker,
    {
      timeout: 120_000,
    },
  );

  const textMarker = `ATTACH_${Math.random().toString(36).slice(2, 10)}`;
  writeFileSync("/tmp/pocodex-mobile-smoke.txt", `The marker is ${textMarker}\n`, "utf8");
  await attachFile(page, "/tmp/pocodex-mobile-smoke.txt");
  await typePrompt(
    page,
    "Read the attached text file and reply exactly with the marker it contains.",
  );
  await clickComposerSend(page);
  await waitForBodyCondition(
    page,
    (marker) => document.body.innerText.includes(marker),
    textMarker,
    "text attachment marker did not appear",
  );

  writeFileSync(
    "/tmp/pocodex-mobile-smoke.png",
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await attachFile(page, "/tmp/pocodex-mobile-smoke.png");
  await page.waitForFunction(
    () => Array.from(document.images).some((image) => image.currentSrc.startsWith("data:image/")),
    null,
    { timeout: 20_000 },
  );

  const finalDebug = await page.evaluate(() => window.__pocodexDebug?.snapshot?.());
  assert(finalDebug?.connectionPhase === "connected", "browser bridge disconnected during smoke");
  assert(finalDebug?.pendingMessages === 0, "browser has queued messages after smoke");

  console.log(
    JSON.stringify(
      {
        ok: true,
        url: targetUrl,
        plainMarker,
        textAttachmentMarker: textMarker,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}

async function typePrompt(page, prompt) {
  const editor = page.locator('textarea, [contenteditable="true"]').last();
  await editor.click();
  await page.keyboard.insertText(prompt);
}

async function clickComposerSend(page) {
  await page.locator("button.bg-token-foreground").last().click();
}

async function attachFile(page, filePath) {
  const filename = basename(filePath);
  await page
    .getByRole("button", {
      name: /Add files and more|Add photos and more|Add photos, remote files, and more/i,
    })
    .first()
    .click();
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 });
  await page
    .getByRole("menuitem", { name: /Add photos & files|Add photos/i })
    .first()
    .click();
  const chooser = await chooserPromise;
  await chooser.setFiles(filePath);
  await page
    .locator('[data-composer-attachments-row="true"]')
    .getByRole("button", { name: filename })
    .first()
    .waitFor({ state: "visible", timeout: 20_000 });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForBodyCondition(page, predicate, argument, message, timeout = 120_000) {
  try {
    await page.waitForFunction(predicate, argument, { timeout });
  } catch (error) {
    const tail = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    throw new Error(`${message}\n\nPage tail:\n${tail.slice(-2_000)}`, { cause: error });
  }
}
