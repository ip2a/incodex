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
  const consoleMessages = [];

  page.on("console", (message) => {
    consoleMessages.push({
      type: message.type(),
      text: message.text(),
    });
  });
  page.on("pageerror", (error) => {
    consoleMessages.push({
      type: "pageerror",
      text: String(error.stack || error.message || error),
    });
  });

  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

  try {
    await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 45_000 });
  } catch (error) {
    const snapshot = await captureSnapshot(page, consoleMessages);
    throw new Error(`Codex app did not render past the startup logo.\n${snapshot}`, {
      cause: error,
    });
  }

  const result = await page.evaluate(() => ({
    bodyText: document.body.innerText,
    debug: window.__pocodexDebug?.snapshot?.(),
    hasStartupLoader: document.querySelector(".startup-loader") !== null,
    main: document.querySelector(".main-surface")?.getBoundingClientRect().toJSON(),
  }));

  assert(result.bodyText.includes("What should we work on?"), "home composer did not render");
  assert(result.debug?.connectionPhase === "connected", "browser bridge is not connected");
  assert(result.debug?.socketReadyState === "OPEN", "websocket is not open");
  assert(result.debug?.pendingMessages === 0, "browser has queued messages");
  assert(result.hasStartupLoader === false, "startup loader is still mounted");
  assert(Number(result.main?.width ?? 0) >= 360, "mobile main pane is too narrow");

  console.log(
    JSON.stringify(
      {
        ok: true,
        url: targetUrl,
        connectionPhase: result.debug.connectionPhase,
        socketReadyState: result.debug.socketReadyState,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}

async function captureSnapshot(page, consoleMessages) {
  const snapshot = await page
    .evaluate(() => ({
      bodyText: document.body.innerText.slice(0, 1_000),
      debug: window.__pocodexDebug?.snapshot?.(),
      rootHtml: document.getElementById("root")?.innerHTML.slice(0, 1_500) ?? null,
    }))
    .catch((error) => ({
      error: String(error),
    }));

  return JSON.stringify(
    {
      snapshot,
      consoleMessages: consoleMessages.slice(-80),
    },
    null,
    2,
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
