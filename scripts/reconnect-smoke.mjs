import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

import { chromium } from "playwright";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let server = null;
const browser = await chromium.launch({
  headless: true,
  executablePath: chromePath,
});

try {
  server = await startServer("127.0.0.1:0");
  const url = server.url;
  const parsedUrl = new URL(url);
  const fixedListen = `127.0.0.1:${parsedUrl.port}`;

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();

  try {
    await page.goto(`${url.endsWith("/") ? url.slice(0, -1) : url}/?pocodexDebug=1`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 45_000 });
    await waitForConnectionPhase(page, "connected", 20_000);

    await stopServer(server);
    server = null;

    await page.waitForFunction(
      () => {
        const snapshot = window.__pocodexDebug?.snapshot?.();
        return (
          snapshot?.connectionPhase === "reconnecting" ||
          snapshot?.connectionPhase === "degraded" ||
          snapshot?.socketReadyState === "CLOSED"
        );
      },
      null,
      { timeout: 20_000 },
    );

    server = await startServer(fixedListen);
    await waitForConnectionPhase(page, "connected", 60_000);

    const debug = await page.evaluate(() => window.__pocodexDebug?.snapshot?.());
    assert(debug?.socketReadyState === "OPEN", "websocket did not reopen after server restart");
    assert(debug?.pendingMessages === 0, "pending messages remained after reconnect");

    console.log(
      JSON.stringify(
        {
          ok: true,
          url,
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
  if (server) {
    await stopServer(server);
  }
  await browser.close().catch(() => undefined);
}

async function startServer(listen) {
  const childProcess = spawn(process.execPath, ["dist/cli.js", "--listen", listen], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const outputLines = [];
  const url = await waitForOpenUrl(childProcess, outputLines);
  return {
    process: childProcess,
    url,
  };
}

async function stopServer(server) {
  server.process.kill("SIGTERM");
  await once(server.process, "exit").catch(() => undefined);
}

async function waitForOpenUrl(process, lines) {
  const stdout = createInterface({ input: process.stdout });
  const stderr = createInterface({ input: process.stderr });
  const timeout = setTimeout(() => {
    process.kill("SIGTERM");
  }, 30_000);

  stderr.on("line", (line) => {
    lines.push(line);
  });

  try {
    for await (const line of stdout) {
      lines.push(line);
      const match = /^Open (http:\/\/\S+)/.exec(line);
      if (match?.[1]) {
        return match[1];
      }
    }
  } finally {
    clearTimeout(timeout);
    stdout.close();
    stderr.close();
  }

  throw new Error(`Pocodex dist server did not print an open URL.\n${lines.join("\n")}`);
}

async function waitForConnectionPhase(page, phase, timeout) {
  await page.waitForFunction(
    (expectedPhase) => window.__pocodexDebug?.snapshot?.().connectionPhase === expectedPhase,
    phase,
    { timeout },
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
