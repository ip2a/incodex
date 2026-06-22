import { extname } from "node:path";

import { serializeInlineScript } from "./inline-script.js";

export interface IncodexPwaConfig {
  appName: string;
  shortName: string;
  description: string;
  themeColor: string;
  backgroundColor: string;
  manifestPath: string;
  iconHref?: string | null;
}

export interface IncodexServiceWorkerConfig {
  cacheName: string;
  indexPath: string;
  serviceWorkerPath: string;
}

interface ManifestIcon {
  src: string;
  type?: string;
  sizes?: string;
}

interface ServiceWorkerRuntimeConfig {
  cacheName: string;
  indexPath: string;
  serviceWorkerPath: string;
}

interface CacheLike {
  add(request: RequestInfo | URL): Promise<void>;
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
}

interface CacheStorageLike {
  delete(cacheName: string): Promise<boolean>;
  keys(): Promise<string[]>;
  open(cacheName: string): Promise<CacheLike>;
}

interface ExtendableEventLike extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEventLike extends ExtendableEventLike {
  request: Request;
  respondWith(response: Promise<Response> | Response): void;
}

interface ServiceWorkerGlobalLike extends EventTarget {
  caches: CacheStorageLike;
  clients: {
    claim(): Promise<void>;
  };
  location: Location;
  skipWaiting(): Promise<void>;
}

export function renderPwaHeadTags(config: IncodexPwaConfig): string[] {
  const tags = [
    `<link rel="manifest" href="${config.manifestPath}" id="incodex-manifest">`,
    `<meta name="application-name" content="${config.appName}" id="incodex-application-name">`,
    `<meta name="theme-color" content="${config.themeColor}" id="incodex-theme-color">`,
    '<meta name="color-scheme" content="dark" id="incodex-color-scheme">',
    '<meta name="mobile-web-app-capable" content="yes" id="incodex-mobile-web-app-capable">',
    '<meta name="apple-mobile-web-app-capable" content="yes" id="incodex-apple-mobile-web-app-capable">',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" id="incodex-apple-mobile-web-app-status-bar-style">',
    `<meta name="apple-mobile-web-app-title" content="${config.shortName}" id="incodex-apple-mobile-web-app-title">`,
  ];

  if (supportsAppleTouchIcon(config.iconHref)) {
    tags.push(
      `<link rel="apple-touch-icon" href="${config.iconHref}" id="incodex-apple-touch-icon">`,
    );
  }

  return tags;
}

export function renderWebManifest(config: IncodexPwaConfig): string {
  const manifest = {
    id: "/",
    name: config.appName,
    short_name: config.shortName,
    description: config.description,
    start_url: "./",
    scope: "/",
    display: "standalone",
    background_color: config.backgroundColor,
    theme_color: config.themeColor,
    icons: buildManifestIcons(config.iconHref),
  };

  return JSON.stringify(manifest, null, 2);
}

export function renderServiceWorkerScript(config: IncodexServiceWorkerConfig): string {
  return serializeInlineScript(registerIncodexServiceWorker, {
    cacheName: config.cacheName,
    indexPath: config.indexPath,
    serviceWorkerPath: config.serviceWorkerPath,
  });
}

function buildManifestIcons(iconHref?: string | null): ManifestIcon[] | undefined {
  if (!iconHref) {
    return undefined;
  }

  const icon: ManifestIcon = {
    src: iconHref,
  };
  const extension = extname(iconHref).toLowerCase();

  if (extension === ".svg") {
    icon.type = "image/svg+xml";
    icon.sizes = "any";
  } else if (extension === ".png") {
    icon.type = "image/png";
  } else if (extension === ".ico") {
    icon.type = "image/x-icon";
  }

  return [icon];
}

function supportsAppleTouchIcon(iconHref?: string | null): iconHref is string {
  return (
    typeof iconHref === "string" &&
    iconHref.length > 0 &&
    extname(iconHref).toLowerCase() === ".png"
  );
}

function registerIncodexServiceWorker(config: ServiceWorkerRuntimeConfig): void {
  const globalScope = self as unknown as ServiceWorkerGlobalLike;
  const cachePrefix = "incodex-shell:";
  const staticDestinations = new Set(["font", "image", "script", "style"]);
  const bypassPaths = new Set([
    "/auth-info",
    "/healthz",
    "/ipc-request",
    "/manifest.webmanifest",
    "/session-check",
  ]);

  globalScope.addEventListener("install", (event: Event) => {
    const installEvent = event as ExtendableEventLike;
    installEvent.waitUntil(
      (async () => {
        const cache = await globalScope.caches.open(config.cacheName);
        await cache.add(config.indexPath);
        await globalScope.skipWaiting();
      })(),
    );
  });

  globalScope.addEventListener("activate", (event: Event) => {
    const activateEvent = event as ExtendableEventLike;
    activateEvent.waitUntil(
      (async () => {
        const cacheNames = await globalScope.caches.keys();
        await Promise.all(
          cacheNames
            .filter(
              (cacheName) => cacheName.startsWith(cachePrefix) && cacheName !== config.cacheName,
            )
            .map(async (cacheName) => globalScope.caches.delete(cacheName)),
        );
        await globalScope.clients.claim();
      })(),
    );
  });

  globalScope.addEventListener("fetch", (event: Event) => {
    const fetchEvent = event as FetchEventLike;
    const { request } = fetchEvent;
    if (request.method !== "GET") {
      return;
    }

    const url = new URL(request.url);
    if (url.origin !== globalScope.location.origin) {
      return;
    }

    if (url.pathname === config.serviceWorkerPath || bypassPaths.has(url.pathname)) {
      return;
    }

    if (
      url.searchParams.has("key") ||
      url.searchParams.has("otp_code") ||
      url.searchParams.has("otp") ||
      url.searchParams.has("token")
    ) {
      return;
    }

    if (request.mode === "navigate") {
      fetchEvent.respondWith(handleNavigationRequest(request));
      return;
    }

    if (url.search.length > 0 || !staticDestinations.has(request.destination)) {
      return;
    }

    fetchEvent.respondWith(handleStaticRequest(request));
  });

  async function handleNavigationRequest(request: Request): Promise<Response> {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await globalScope.caches.open(config.cacheName);
        await cache.put(config.indexPath, response.clone());
      }
      return response;
    } catch {
      const cache = await globalScope.caches.open(config.cacheName);
      const cached = await cache.match(config.indexPath);
      return (
        cached ??
        new Response("Incodex is unavailable offline.", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        })
      );
    }
  }

  async function handleStaticRequest(request: Request): Promise<Response> {
    const cache = await globalScope.caches.open(config.cacheName);
    const cachedResponse = await cache.match(request);
    const networkResponsePromise = fetch(request)
      .then(async (response) => {
        if (response.ok) {
          await cache.put(request, response.clone());
        }
        return response;
      })
      .catch(() => null);

    if (cachedResponse) {
      void networkResponsePromise;
      return cachedResponse;
    }

    const networkResponse = await networkResponsePromise;
    return (
      networkResponse ??
      new Response("Incodex asset unavailable.", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    );
  }
}
