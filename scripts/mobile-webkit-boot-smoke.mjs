import { webkit } from "playwright";

const targetUrl = process.env.POCODEX_SMOKE_URL ?? "http://127.0.0.1:8787/?pocodexDebug=1";

const browser = await webkit.launch({
  headless: true,
});

try {
  const context = await browser.newContext({
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();

  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 45_000 });

    const debug = await page.evaluate(() => window.__pocodexDebug?.snapshot?.());
    assert(debug?.connectionPhase === "connected", "browser bridge is not connected");
    assert(debug?.socketReadyState === "OPEN", "websocket is not open");
    assert(debug?.pendingMessages === 0, "browser has queued messages");

    console.log(
      JSON.stringify(
        {
          ok: true,
          engine: "webkit",
          url: targetUrl,
          connectionPhase: debug.connectionPhase,
          socketReadyState: debug.socketReadyState,
        },
        null,
        2,
      ),
    );
  } finally {
    await context.close().catch(() => undefined);
  }
} finally {
  await browser.close().catch(() => undefined);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
