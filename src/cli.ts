#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { AppServerBridge } from "./lib/app-server-bridge.js";
import { createAuthController, startOtpCodeLogging, type OtpCodeSnapshot } from "./lib/auth.js";
import { normalizeCliArgv } from "./lib/cli-args.js";
import { loadCodexBundle, resolveDefaultCodexAppPath } from "./lib/codex-bundle.js";
import { renderBootstrapScript } from "./lib/bootstrap-script.js";
import { patchIndexHtml } from "./lib/html-patcher.js";
import {
  applySecurityKeyOverride,
  loadIncodexConfig,
  resolveListenHostForAccess,
} from "./lib/incodex-config.js";
import { parseListenAddress } from "./lib/listen-address.js";
import { renderPwaHeadTags, renderServiceWorkerScript, renderWebManifest } from "./lib/pwa.js";
import type { SentryInitOptions, ServeCommandOptions } from "./lib/protocol.js";
import { getServeUrls } from "./lib/serve-url.js";
import { IncodexServer } from "./lib/server.js";
import {
  deriveLastUsedCodexBuildPath,
  formatCodexBuildSignature,
  recordUsedCodexBuild,
} from "./lib/used-codex-build.js";

const DEFAULT_LISTEN_PORT = 8787;
const INCODEX_BACKGROUND_COLOR = "#111827";
const INCODEX_MANIFEST_HREF = "/manifest.webmanifest";
const INCODEX_PWA_APP_NAME = "Incodex";
const INCODEX_PWA_DESCRIPTION = "Run the Codex desktop webview in an installable browser shell.";
const INCODEX_SERVICE_WORKER_HREF = "/service-worker.js";
const INCODEX_STYLESHEET_HREF = "/incodex.css";
const INCODEX_THEME_COLOR = "#111827";
const FLAG_NAMES_WITH_VALUES = new Set(["--app", "--listen", "--tls-cert", "--tls-key", "--token"]);
const BOOLEAN_FLAG_NAMES = new Set(["--dev"]);

async function main(): Promise<void> {
  const argv = normalizeCliArgv(process.argv.slice(2));
  const command = argv[0];

  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command && command !== "serve" && !command.startsWith("--")) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const serveArgv = command === "serve" ? argv.slice(1) : argv;
  if (serveArgv.includes("help") || serveArgv.includes("--help") || serveArgv.includes("-h")) {
    printUsage();
    return;
  }

  const options = await parseServeCommand(serveArgv);
  const incodexCssPath = fileURLToPath(new URL("./incodex.css", import.meta.url));
  const importIconSvgPath = fileURLToPath(new URL("./images/import.svg", import.meta.url));
  const bundle = await loadCodexBundle(options.appPath);
  const usedCodexBuild = await recordUsedCodexBuild(deriveLastUsedCodexBuildPath(), {
    version: bundle.version,
    buildFlavor: bundle.buildFlavor,
    buildNumber: bundle.buildNumber,
  }).catch(() => null);
  const relay = await AppServerBridge.connect({
    appPath: options.appPath,
    cwd: process.cwd(),
  });

  const sentryOptions: SentryInitOptions = {
    buildFlavor: bundle.buildFlavor,
    appVersion: bundle.version,
    buildNumber: bundle.buildNumber,
    codexAppSessionId: randomUUID(),
  };
  const pwaConfig = {
    appName: INCODEX_PWA_APP_NAME,
    shortName: INCODEX_PWA_APP_NAME,
    description: INCODEX_PWA_DESCRIPTION,
    themeColor: INCODEX_THEME_COLOR,
    backgroundColor: INCODEX_BACKGROUND_COLOR,
    manifestPath: INCODEX_MANIFEST_HREF,
    iconHref: bundle.faviconHref,
  };
  const tls =
    options.tlsCertPath && options.tlsKeyPath
      ? {
          cert: await readFile(options.tlsCertPath),
          key: await readFile(options.tlsKeyPath),
        }
      : undefined;
  const protocol = tls ? "https" : "http";

  const server = new IncodexServer({
    listenHost: options.listenHost,
    listenPort: options.listenPort,
    protocol,
    tls,
    auth: options.auth,
    relay,
    webviewRoot: bundle.webviewRoot,
    readIncodexStylesheet: async () => readFile(incodexCssPath, "utf8"),
    renderIndexHtml: async () => {
      const indexHtml = await bundle.readIndexHtml();
      return patchIndexHtml(indexHtml, {
        bootstrapScript: renderBootstrapScript({
          devMode: options.devMode,
          sentryOptions,
          stylesheetHref: INCODEX_STYLESHEET_HREF,
          importIconSvg: await readFile(importIconSvgPath, "utf8"),
        }),
        faviconHref: bundle.faviconHref,
        headTags: renderPwaHeadTags(pwaConfig),
        stylesheetHref: INCODEX_STYLESHEET_HREF,
      });
    },
    renderWebManifest: async () => renderWebManifest(pwaConfig),
    renderServiceWorkerScript: async () =>
      renderServiceWorkerScript({
        cacheName: `incodex-shell:${bundle.version}:${bundle.buildNumber}`,
        indexPath: "/index.html",
        serviceWorkerPath: INCODEX_SERVICE_WORKER_HREF,
      }),
  });

  const stopWatchingStylesheet = options.devMode
    ? watchIncodexStylesheet(incodexCssPath, () => {
        server.notifyStylesheetReload(String(Date.now()));
      })
    : () => {};
  let stopOtpCodeLogging = () => {};

  const shutdown = async (signal: string) => {
    console.log(`\nShutting down Incodex after ${signal}...`);
    stopOtpCodeLogging();
    stopWatchingStylesheet();
    await server.close();
    await relay.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await server.listen();
  const listeningAddress = server.getAddress();
  const serveUrls = getServeUrls({
    listenHost: options.listenHost,
    listenPort: listeningAddress.port,
    protocol,
    appendOpenUrlCredentials: (url) => {
      options.auth.appendOpenUrlCredentials(url);
    },
  });
  stopOtpCodeLogging = startOtpCodeLogging(options.auth, (otpCode) => {
    console.log(formatOtpCodeMessage(otpCode));
  });

  console.log(`Incodex listening on ${serveUrls.localUrl}`);
  console.log(`Open ${serveUrls.localOpenUrl}`);
  if (serveUrls.networkUrl && serveUrls.networkOpenUrl) {
    console.log(`Local network URL ${serveUrls.networkUrl}`);
    console.log(`Open on your local network ${serveUrls.networkOpenUrl}`);
  } else if (options.listenHost === "0.0.0.0") {
    console.log("Local network URL unavailable; no active LAN IPv4 address was detected.");
  } else if (options.listenHost === "127.0.0.1" || options.listenHost === "localhost") {
    console.log(
      `Local network URL unavailable while listening on ${serveUrls.localUrl} (use --listen 0.0.0.0:${listeningAddress.port} to expose it on your LAN)`,
    );
  }
  console.log(
    `Using Incodex config ${options.configPath}${options.configCreated ? " (created)" : ""}`,
  );
  console.log(`Using auth mode ${options.auth.getChallenge().mode}`);
  console.log(`Using Codex ${bundle.version} from ${bundle.appPath}`);
  if (usedCodexBuild?.isUpdated && usedCodexBuild.previousBuild) {
    console.log(
      `Updated Codex detected: now using ${formatCodexBuildSignature(usedCodexBuild.currentBuild)}, previously ${formatCodexBuildSignature(usedCodexBuild.previousBuild)}`,
    );
  }
  console.log(`Using direct app-server bridge from ${bundle.appPath}`);
  if (options.devMode) {
    console.log(`Watching ${incodexCssPath} for stylesheet changes`);
  }
}

async function parseServeCommand(argv: string[]): Promise<ServeCommandOptions> {
  validateServeArgs(argv);

  const appPath = readFlag(argv, "--app") ?? (await resolveDefaultCodexAppPath());
  const loadedConfig = await loadIncodexConfig();
  const authConfig = applySecurityKeyOverride(
    loadedConfig.config,
    readFlag(argv, "--token") ?? null,
  );
  const auth = createAuthController(authConfig);
  const listen =
    readFlag(argv, "--listen") ??
    `${resolveListenHostForAccess(authConfig.server.access)}:${DEFAULT_LISTEN_PORT}`;
  const tlsCertPath = readFlag(argv, "--tls-cert") ?? null;
  const tlsKeyPath = readFlag(argv, "--tls-key") ?? null;
  const devMode = hasFlag(argv, "--dev");

  if ((tlsCertPath === null) !== (tlsKeyPath === null)) {
    throw new Error("--tls-cert and --tls-key must be provided together");
  }

  const parsedListenAddress = parseListenAddress(listen);
  if (!parsedListenAddress) {
    throw new Error(`Invalid --listen value: ${listen}`);
  }
  if (isNetworkExposedListenHost(parsedListenAddress.listenHost) && !auth.isAuthRequired()) {
    throw new Error(
      `LAN access requires auth. Set auth.mode to "otp_code", "key", or "code_and_key" in ${loadedConfig.configPath}.`,
    );
  }

  return {
    appPath,
    auth,
    configCreated: loadedConfig.created,
    configPath: loadedConfig.configPath,
    devMode,
    listenHost: parsedListenAddress.listenHost,
    listenPort: parsedListenAddress.listenPort,
    tlsCertPath,
    tlsKeyPath,
  };
}

function validateServeArgs(argv: string[]): void {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("-")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    if (BOOLEAN_FLAG_NAMES.has(arg)) {
      continue;
    }

    if (FLAG_NAMES_WITH_VALUES.has(arg)) {
      index += 1;
      const value = argv[index];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      continue;
    }

    throw new Error(`Unknown flag: ${arg}`);
  }
}

function readFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function printUsage(): void {
  console.error("Usage:");
  console.error(
    "  incodex [--token <secret>] [--app <path>] [--listen 127.0.0.1:8787] [--tls-cert <cert.pem> --tls-key <key.pem>] [--dev]",
  );
}

function isNetworkExposedListenHost(listenHost: string): boolean {
  return listenHost !== "127.0.0.1" && listenHost !== "localhost";
}

function formatOtpCodeMessage(otpCode: OtpCodeSnapshot): string {
  const suffix =
    otpCode.rotation === "interval" && otpCode.expiresAt !== null
      ? ` (expires ${new Date(otpCode.expiresAt).toLocaleTimeString()})`
      : "";
  return `Incodex OTP code: ${otpCode.code}${suffix}`;
}

function watchIncodexStylesheet(cssFilePath: string, onChange: () => void): () => void {
  const cssDirectory = dirname(cssFilePath);
  const cssFilename = basename(cssFilePath);
  let debounceTimer: NodeJS.Timeout | undefined;

  const watcher = watch(cssDirectory, (_eventType, changedFilename) => {
    const changedName = changedFilename ? String(changedFilename) : undefined;
    if (changedName && changedName !== cssFilename) {
      return;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      onChange();
    }, 50);
  });

  return () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    watcher.close();
  };
}

await main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});
