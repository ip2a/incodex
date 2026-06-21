import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

import { chromium } from "playwright";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const server = spawn(process.execPath, ["dist/cli.js", "--listen", "127.0.0.1:0"], {
  stdio: ["ignore", "pipe", "pipe"],
});
const outputLines = [];

try {
  const url = await waitForOpenUrl(server, outputLines);
  const result = await runPwaSmoke(url);

  console.log(
    JSON.stringify(
      {
        ok: true,
        url,
        ...result,
      },
      null,
      2,
    ),
  );
} finally {
  server.kill("SIGTERM");
  await once(server, "exit").catch(() => undefined);
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

async function runPwaSmoke(url) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();

    try {
      const targetUrl = `${url.endsWith("/") ? url.slice(0, -1) : url}/?pocodexDebug=1`;
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 45_000 });

      const metadata = await page.evaluate(async () => {
        const manifestHref = document.querySelector('link[rel="manifest"]')?.getAttribute("href");
        const applicationName = document
          .querySelector('meta[name="application-name"]')
          ?.getAttribute("content");
        const themeColor = document
          .querySelector('meta[name="theme-color"]')
          ?.getAttribute("content");

        const manifestResponse = manifestHref ? await fetch(manifestHref) : null;
        const manifest = manifestResponse?.ok ? await manifestResponse.json() : null;
        const serviceWorkerResponse = await fetch("/service-worker.js", { cache: "no-store" });

        return {
          applicationName,
          manifest,
          manifestContentType: manifestResponse?.headers.get("content-type") ?? null,
          manifestHref,
          serviceWorkerContentType: serviceWorkerResponse.headers.get("content-type"),
          serviceWorkerStatus: serviceWorkerResponse.status,
          themeColor,
        };
      });

      assert(metadata.manifestHref === "/manifest.webmanifest", "manifest link is missing");
      assert(metadata.applicationName === "Pocodex", "application name meta is missing");
      assert(metadata.themeColor === "#111827", "theme-color meta is missing");
      assert(metadata.manifest?.display === "standalone", "manifest display is not standalone");
      assert(metadata.manifest?.scope === "/", "manifest scope is not root");
      assert(metadata.serviceWorkerStatus === 200, "service worker script did not load");

      const registration = await page.evaluate(async () => {
        if (!("serviceWorker" in navigator)) {
          return null;
        }

        await navigator.serviceWorker.ready;
        const currentRegistration = await navigator.serviceWorker.getRegistration("/");
        return {
          activeScriptURL: currentRegistration?.active?.scriptURL ?? null,
          scope: currentRegistration?.scope ?? null,
        };
      });

      assert(
        registration?.activeScriptURL?.endsWith("/service-worker.js"),
        "service worker inactive",
      );

      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 45_000 });

      await context.setOffline(true);
      const offlineResponse = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      const offlineText = await page.locator("body").innerText({ timeout: 10_000 });

      assert(offlineResponse?.status() === 200, "offline navigation did not use cached shell");
      assert(
        offlineText.includes("What should we work on?") ||
          offlineText.includes("Pocodex") ||
          offlineText.includes("connection"),
        "offline shell did not render recognizable content",
      );

      return {
        manifestName: metadata.manifest?.name,
        registrationScope: registration.scope,
      };
    } finally {
      await context.close().catch(() => undefined);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
