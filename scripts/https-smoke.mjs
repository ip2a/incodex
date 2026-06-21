import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { chromium } from "playwright";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-https-smoke-"));
const certPath = join(tempDirectory, "cert.pem");
const keyPath = join(tempDirectory, "key.pem");
const opensslConfigPath = join(tempDirectory, "openssl.cnf");
const serviceWorkerReadyTimeoutMs = 15_000;
let server = null;

try {
  await writeFile(
    opensslConfigPath,
    [
      "[req]",
      "distinguished_name=req_distinguished_name",
      "x509_extensions=v3_req",
      "prompt=no",
      "",
      "[req_distinguished_name]",
      "CN=localhost",
      "",
      "[v3_req]",
      "subjectAltName=@alt_names",
      "",
      "[alt_names]",
      "DNS.1=localhost",
      "IP.1=127.0.0.1",
      "",
    ].join("\n"),
  );
  await generateCertificate();

  server = await startServer();
  const result = await runHttpsSmoke(server.url);

  console.log(
    JSON.stringify(
      {
        ok: true,
        url: server.url,
        ...result,
      },
      null,
      2,
    ),
  );
} finally {
  if (server) {
    await stopServer(server);
  }
  await rm(tempDirectory, { force: true, recursive: true }).catch(() => undefined);
}

async function generateCertificate() {
  const openssl = spawn("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-config",
    opensslConfigPath,
  ]);

  const [code, signal] = await once(openssl, "exit");
  if (code !== 0) {
    throw new Error(`openssl failed with ${signal ?? `exit code ${code}`}`);
  }
}

async function startServer() {
  const childProcess = spawn(
    process.execPath,
    ["dist/cli.js", "--listen", "127.0.0.1:0", "--tls-cert", certPath, "--tls-key", keyPath],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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
      const match = /^Open (https:\/\/\S+)/.exec(line);
      if (match?.[1]) {
        return match[1];
      }
    }
  } finally {
    clearTimeout(timeout);
    stdout.close();
    stderr.close();
  }

  throw new Error(`Pocodex HTTPS server did not print an HTTPS open URL.\n${lines.join("\n")}`);
}

async function runHttpsSmoke(url) {
  const origin = new URL(url).origin;
  const browser = await chromium.launch({
    args: ["--ignore-certificate-errors", `--unsafely-treat-insecure-origin-as-secure=${origin}`],
    executablePath: chromePath,
    headless: true,
  });

  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    const consoleMessages = [];
    const pageErrors = [];

    page.on("console", (message) => {
      consoleMessages.push({
        location: message.location(),
        text: message.text(),
        type: message.type(),
      });
    });
    page.on("pageerror", (error) => {
      pageErrors.push(error.stack ?? error.message);
    });

    try {
      await page.goto(`${url.endsWith("/") ? url.slice(0, -1) : url}/?pocodexDebug=1`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 45_000 });

      const debug = await page.evaluate(() => window.__pocodexDebug?.snapshot?.());
      assert(debug?.connectionPhase === "connected", "browser bridge is not connected");
      assert(debug?.socketReadyState === "OPEN", "websocket is not open");

      const registration = await page.evaluate(async () => {
        const ready = navigator.serviceWorker.ready;
        await Promise.race([
          ready,
          new Promise((_, reject) => {
            window.setTimeout(() => {
              reject(new Error("service worker ready timed out"));
            }, 15_000);
          }),
        ]);
        const currentRegistration = await navigator.serviceWorker.getRegistration("/");
        return {
          activeScriptURL: currentRegistration?.active?.scriptURL ?? null,
          isSecureContext: window.isSecureContext,
          protocol: window.location.protocol,
          serviceWorkerSupported: "serviceWorker" in navigator,
          scope: currentRegistration?.scope ?? null,
        };
      });

      assert(registration.isSecureContext, "HTTPS page is not a secure context");
      assert(registration.protocol === "https:", "page did not load over HTTPS");
      assert(
        registration.activeScriptURL?.endsWith("/service-worker.js"),
        "service worker did not activate on HTTPS",
      );

      return {
        consoleMessages: consoleMessages.slice(-20),
        connectionPhase: debug.connectionPhase,
        pageErrors,
        registrationScope: registration.scope,
        socketReadyState: debug.socketReadyState,
      };
    } catch (error) {
      const diagnostics = await collectDiagnostics(page).catch((diagnosticError) => ({
        diagnosticError:
          diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError),
      }));
      const detail = JSON.stringify(
        {
          consoleMessages: consoleMessages.slice(-20),
          diagnostics,
          error: error instanceof Error ? error.message : String(error),
          pageErrors,
          serviceWorkerReadyTimeoutMs,
        },
        null,
        2,
      );
      throw new Error(`HTTPS smoke failed.\n${detail}`);
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

async function collectDiagnostics(page) {
  return page.evaluate(async () => {
    const registrations =
      "serviceWorker" in navigator
        ? await navigator.serviceWorker.getRegistrations().then((items) =>
            items.map((registration) => ({
              active: registration.active?.scriptURL ?? null,
              installing: registration.installing?.scriptURL ?? null,
              scope: registration.scope,
              waiting: registration.waiting?.scriptURL ?? null,
            })),
          )
        : [];
    return {
      bodyText: document.body?.innerText?.slice(0, 1000) ?? "",
      debug: window.__pocodexDebug?.snapshot?.() ?? null,
      href: window.location.href,
      isSecureContext: window.isSecureContext,
      protocol: window.location.protocol,
      registrations,
      serviceWorkerController: navigator.serviceWorker?.controller?.scriptURL ?? null,
      serviceWorkerSupported: "serviceWorker" in navigator,
    };
  });
}
