import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { basename, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";

import mimeTypes from "mime-types";
import { WebSocket, WebSocketServer } from "ws";

import { readAuthCredentialsFromUrl } from "./auth.js";
import { debugLog, isDebugEnabled } from "./debug.js";
import { getUnsupportedBridgeNotice } from "./native-policy.js";
import type {
  JsonRecord,
  BrowserToServerEnvelope,
  IncodexServerOptions,
  ServerToBrowserEnvelope,
} from "./protocol.js";
import { routeHostMessage, rewriteRequestIdsForHost } from "./request-id.js";

interface BrowserSession {
  id: string;
  socket: WebSocket;
  subscribedWorkers: Set<string>;
  isFocused: boolean;
  terminalSessionIdsByLocalSessionId: Map<string, string>;
  lastHeartbeatAckAt: number;
}

interface TerminalSessionRoute {
  id: string;
  conversationId: string | null;
  ownerBrowserSessionId: string | null;
  participantOrder: string[];
  localSessionIdsByBrowserSessionId: Map<string, string>;
}

const TERMINAL_CONTROL_MESSAGE_TYPES = new Set([
  "terminal-write",
  "terminal-run-action",
  "terminal-resize",
  "terminal-close",
]);
const TERMINAL_ATTACH_MESSAGE_TYPES = new Set(["terminal-create", "terminal-attach"]);
const TERMINAL_STREAM_MESSAGE_TYPES = new Set(["terminal-data", "terminal-error", "terminal-exit"]);
const TERMINAL_TARGET_BROWSER_SESSION_ID_KEY = "_incodexBrowserSessionId";
const TERMINAL_TARGET_BROWSER_TERMINAL_SESSION_ID_KEY = "_incodexBrowserTerminalSessionId";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
const SLOW_IPC_REQUEST_THRESHOLD_MS = 25_000;
const BROWSER_FILE_UPLOAD_PATH = "/incodex-browser-file";
const MAX_BROWSER_FILE_UPLOAD_BYTES = 100 * 1024 * 1024;

export class IncodexServer {
  private readonly httpServer: HttpServer;
  private readonly wsServer: WebSocketServer;
  private readonly pendingBySocket = new WeakMap<WebSocket, Promise<void>>();
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly workerSubscriberCounts = new Map<string, number>();
  private readonly terminalSessionRoutes = new Map<string, TerminalSessionRoute>();
  private readonly terminalSessionIdsByConversation = new Map<string, string>();
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly heartbeatTimer: NodeJS.Timeout;
  private indexHtmlPromise?: Promise<string>;
  private serviceWorkerScriptPromise?: Promise<string>;
  private webManifestPromise?: Promise<string>;

  constructor(private readonly options: IncodexServerOptions) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = Math.max(
      options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
      this.heartbeatIntervalMs + 1,
    );
    const requestHandler = (request: IncomingMessage, response: ServerResponse) => {
      void this.handleHttpRequest(request, response);
    };
    this.httpServer = options.tls
      ? createHttpsServer(
          {
            cert: options.tls.cert,
            key: options.tls.key,
          },
          requestHandler,
        )
      : createHttpServer(requestHandler);
    this.wsServer = new WebSocketServer({ noServer: true });

    this.httpServer.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
    this.wsServer.on("connection", (socket) => {
      this.handleConnection(socket);
    });

    this.options.relay.on("bridge_message", (message) => {
      this.handleRelayBridgeMessage(message);
    });
    this.options.relay.on("worker_message", (workerName, message) => {
      this.handleRelayWorkerMessage(workerName, message);
    });
    this.options.relay.on("error", (error) => {
      this.broadcast({
        type: "error",
        message: error.message,
      });
    });

    this.heartbeatTimer = setInterval(() => {
      this.handleHeartbeatTick();
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.options.listenPort, this.options.listenHost, () => {
        this.httpServer.off("error", reject);
        resolvePromise();
      });
    });
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeatTimer);
    for (const session of this.sessions.values()) {
      session.socket.close(1000, "shutdown");
    }
    this.sessions.clear();
    this.workerSubscriberCounts.clear();
    this.terminalSessionRoutes.clear();
    this.terminalSessionIdsByConversation.clear();

    for (const client of this.wsServer.clients) {
      client.terminate();
    }

    await new Promise<void>((resolvePromise) => {
      this.wsServer.close(() => resolvePromise());
    });

    await new Promise<void>((resolvePromise, reject) => {
      this.httpServer.closeIdleConnections?.();
      this.httpServer.closeAllConnections?.();
      this.httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise();
      });
    });
  }

  getAddress(): AddressInfo {
    const address = this.httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Incodex server is not listening on a TCP address");
    }
    return address;
  }

  notifyStylesheetReload(versionTag: string): void {
    this.broadcast({
      type: "css_reload",
      href: `/incodex.css?v=${encodeURIComponent(versionTag)}`,
    });
  }

  private async handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(
      request.url ?? "/",
      `${this.getProtocol()}://${this.options.listenHost}:${this.options.listenPort}`,
    );

    if (url.pathname === "/" || url.pathname === "/index.html") {
      response.statusCode = 200;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(await this.getIndexHtml());
      return;
    }

    if (url.pathname === "/session-check") {
      const authorized = this.isAuthorized(url);
      response.statusCode = authorized ? 200 : 401;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ ok: authorized }));
      return;
    }

    if (url.pathname === "/auth-info") {
      response.statusCode = 200;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ auth: this.options.auth.getChallenge() }));
      return;
    }

    if (url.pathname === "/incodex.css") {
      try {
        response.statusCode = 200;
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", "text/css; charset=utf-8");
        response.end(await this.options.readIncodexStylesheet());
      } catch {
        response.statusCode = 500;
        response.end("Unable to load Incodex stylesheet");
      }
      return;
    }

    if (url.pathname === "/manifest.webmanifest") {
      response.statusCode = 200;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
      response.end(await this.getWebManifest());
      return;
    }

    if (url.pathname === "/service-worker.js") {
      response.statusCode = 200;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "text/javascript; charset=utf-8");
      response.setHeader("Service-Worker-Allowed", "/");
      response.end(await this.getServiceWorkerScript());
      return;
    }

    if (url.pathname === "/healthz") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/ipc-request") {
      await this.handleIpcRequest(request, response);
      return;
    }

    if (url.pathname === BROWSER_FILE_UPLOAD_PATH) {
      await this.handleBrowserFileUpload(request, response, url);
      return;
    }

    const relativePath = url.pathname.replace(/^\/+/, "");
    const absolutePath = resolve(this.options.webviewRoot, relativePath);
    if (!absolutePath.startsWith(`${this.options.webviewRoot}${sep}`)) {
      response.statusCode = 404;
      response.end("Not found");
      return;
    }

    try {
      const fileBuffer = await readFile(absolutePath);
      const diagnosticScript = maybePatchCodexWebviewScript(url.pathname, fileBuffer);
      response.statusCode = 200;
      response.setHeader("Cache-Control", diagnosticScript ? "no-store" : "public, max-age=3600");
      response.setHeader(
        "Content-Type",
        mimeTypes.lookup(absolutePath) || "application/octet-stream",
      );
      response.end(diagnosticScript ?? fileBuffer);
    } catch {
      if (shouldServeSpaShell(request.method, url.pathname)) {
        response.statusCode = 200;
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(await this.getIndexHtml());
        return;
      }
      response.statusCode = 404;
      response.end("Not found");
    }
  }

  private async handleBrowserFileUpload(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ error: "Method not allowed." }));
      return;
    }

    if (!this.isAuthorized(url)) {
      response.statusCode = 401;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ error: "Unauthorized." }));
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > MAX_BROWSER_FILE_UPLOAD_BYTES) {
        response.statusCode = 413;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ error: "Uploaded file is too large." }));
        return;
      }
      chunks.push(buffer);
    }

    const originalName = url.searchParams.get("name") ?? "attachment";
    const safeName = sanitizeBrowserUploadFilename(originalName);
    const uploadDirectory = join(tmpdir(), "incodex-browser-files");
    await mkdir(uploadDirectory, { recursive: true });
    const filePath = join(uploadDirectory, `${Date.now()}-${randomUUID()}-${safeName}`);
    await writeFile(filePath, Buffer.concat(chunks, totalBytes));

    debugLog("server", "stored browser file upload", {
      path: filePath,
      bytes: totalBytes,
    });

    response.statusCode = 200;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ path: filePath }));
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(
      request.url ?? "/",
      `${this.getProtocol()}://${this.options.listenHost}:${this.options.listenPort}`,
    );
    if (url.pathname !== "/session") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!this.isAuthorized(url)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    this.wsServer.handleUpgrade(request, socket, head, (upgradedSocket) => {
      this.wsServer.emit("connection", upgradedSocket, request);
    });
  }

  private handleConnection(socket: WebSocket): void {
    const session: BrowserSession = {
      id: randomUUID(),
      socket,
      subscribedWorkers: new Set(),
      isFocused: true,
      terminalSessionIdsByLocalSessionId: new Map(),
      lastHeartbeatAckAt: Date.now(),
    };
    this.sessions.set(session.id, session);
    debugLog("server", "browser connected", { sessionId: session.id });

    socket.on("message", (data) => {
      const previous = this.pendingBySocket.get(socket) ?? Promise.resolve();
      const next = previous
        .then(() => this.handleSocketMessage(session, String(data)))
        .catch((error) => {
          this.send(socket, {
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        });
      this.pendingBySocket.set(socket, next);
    });

    socket.on("close", () => {
      debugLog("server", "browser disconnected", { sessionId: session.id });
      if (this.sessions.get(session.id) !== session) {
        return;
      }
      this.cleanupSession(session);
    });
  }

  private isAuthorized(url: URL): boolean {
    return this.options.auth.authorize(readAuthCredentialsFromUrl(url));
  }

  private async handleSocketMessage(session: BrowserSession, raw: string): Promise<void> {
    const envelope = JSON.parse(raw) as BrowserToServerEnvelope;
    session.lastHeartbeatAckAt = Date.now();
    debugLog("server", "browser message", envelope);

    if (this.sessions.get(session.id) !== session) {
      this.send(session.socket, {
        type: "session_revoked",
        reason: "This Incodex session is no longer active.",
      });
      session.socket.close(4001, "inactive");
      return;
    }

    switch (envelope.type) {
      case "bridge_message":
        await this.handleBridgeEnvelope(session, envelope.message);
        break;
      case "worker_subscribe":
        if (!session.subscribedWorkers.has(envelope.workerName)) {
          session.subscribedWorkers.add(envelope.workerName);
          await this.incrementWorkerSubscribers(envelope.workerName);
        }
        break;
      case "worker_unsubscribe":
        if (session.subscribedWorkers.delete(envelope.workerName)) {
          await this.decrementWorkerSubscribers(envelope.workerName);
        }
        break;
      case "worker_message":
        void this.options.relay
          .sendWorkerMessage(envelope.workerName, envelope.message)
          .catch((error) => {
            this.send(session.socket, {
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          });
        break;
      case "focus_state":
        session.isFocused = envelope.isFocused;
        this.send(session.socket, {
          type: "bridge_message",
          message: {
            type: "electron-window-focus-changed",
            isFocused: envelope.isFocused,
          },
        });
        break;
      case "heartbeat_ack":
        break;
      default:
        this.send(session.socket, {
          type: "error",
          message: `Unknown Incodex browser message ${(envelope as { type: string }).type}`,
        });
    }
  }

  private async handleBridgeEnvelope(session: BrowserSession, message: unknown): Promise<void> {
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      (message as { type?: unknown }).type === "electron-window-focus-request"
    ) {
      this.send(session.socket, {
        type: "bridge_message",
        message: {
          type: "electron-window-focus-changed",
          isFocused: session.isFocused,
        },
      });
      return;
    }

    if (isTerminalBridgeMessage(message)) {
      await this.handleTerminalBridgeEnvelope(session, message);
      return;
    }

    const blockedNotice = getUnsupportedBridgeNotice(message);
    if (blockedNotice) {
      debugLog("server", "blocked browser bridge message", {
        message,
        blockedNotice,
      });
      // this.send(session.socket, {
      //   type: "client_notice",
      //   message: blockedNotice,
      // });
      return;
    }

    const rewrittenMessage = rewriteRequestIdsForHost(session.id, message);
    debugLog("server", "forwarding bridge message to relay", rewrittenMessage);
    if (isAsyncBridgeRelayMessage(rewrittenMessage)) {
      void this.options.relay.forwardBridgeMessage(rewrittenMessage).catch((error) => {
        this.send(session.socket, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }

    await this.options.relay.forwardBridgeMessage(rewrittenMessage);
  }

  private async handleIpcRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const startedAt = Date.now();
    const rawBody = await readRequestBody(request);
    let payload: unknown;
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      response.statusCode = 400;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          requestId: "",
          type: "response",
          resultType: "error",
          error: "Invalid JSON body.",
        }),
      );
      return;
    }

    const requestId = extractRequestId(payload);
    const method = extractMethod(payload);
    const slowRequestTimer = setTimeout(() => {
      debugLog("ipc", "host ipc request still pending", {
        requestId,
        method,
        elapsedMs: Date.now() - startedAt,
      });
    }, SLOW_IPC_REQUEST_THRESHOLD_MS);
    slowRequestTimer.unref();

    debugLog("ipc", "host ipc request start", {
      requestId,
      method,
    });

    if (!this.options.relay.handleIpcRequest) {
      clearTimeout(slowRequestTimer);
      debugLog("ipc", "host ipc request unsupported", {
        requestId,
        method,
        elapsedMs: Date.now() - startedAt,
      });
      response.statusCode = 501;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          requestId,
          type: "response",
          resultType: "error",
          error: "IPC requests are not supported by the active host bridge.",
        }),
      );
      return;
    }

    try {
      const result = await this.options.relay.handleIpcRequest(payload);
      clearTimeout(slowRequestTimer);
      debugLog("ipc", "host ipc request success", {
        requestId,
        method,
        elapsedMs: Date.now() - startedAt,
      });
      response.statusCode = 200;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify(result));
    } catch (error) {
      clearTimeout(slowRequestTimer);
      debugLog("ipc", "host ipc request error", {
        requestId,
        method,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      response.statusCode = 500;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          requestId,
          type: "response",
          resultType: "error",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  private handleRelayBridgeMessage(message: unknown): void {
    debugLog("server", "relay bridge message", message);
    const routed = routeHostMessage(message);
    if (!routed.deliver || !routed.message) {
      debugLog("server", "dropped relay bridge message", routed);
      return;
    }

    const bridgeMessage = routed.message;
    if (routed.sessionId) {
      this.sendBridgeMessageToSession(routed.sessionId, bridgeMessage);
      return;
    }

    if (!isJsonRecord(bridgeMessage) || typeof bridgeMessage.type !== "string") {
      this.broadcast({
        type: "bridge_message",
        message: bridgeMessage,
      });
      return;
    }

    const typedBridgeMessage = bridgeMessage as JsonRecord & { type: string };

    if (this.handleTargetedTerminalRelayMessage(typedBridgeMessage)) {
      return;
    }

    if (this.handleTerminalStreamRelayMessage(typedBridgeMessage)) {
      return;
    }

    this.broadcast({
      type: "bridge_message",
      message: stripInternalBridgeFields(typedBridgeMessage),
    });
  }

  private handleRelayWorkerMessage(workerName: string, message: unknown): void {
    debugLog("server", "relay worker message", { workerName, message });
    for (const session of this.sessions.values()) {
      if (!session.subscribedWorkers.has(workerName)) {
        continue;
      }
      this.send(session.socket, {
        type: "worker_message",
        workerName,
        message,
      });
    }
  }

  private async handleTerminalBridgeEnvelope(
    session: BrowserSession,
    message: JsonRecord & { type: string },
  ): Promise<void> {
    if (TERMINAL_ATTACH_MESSAGE_TYPES.has(message.type)) {
      await this.handleTerminalAttachEnvelope(session, message);
      return;
    }

    if (TERMINAL_CONTROL_MESSAGE_TYPES.has(message.type)) {
      await this.handleTerminalControlEnvelope(session, message);
      return;
    }

    await this.options.relay.forwardBridgeMessage(message);
  }

  private async handleTerminalAttachEnvelope(
    session: BrowserSession,
    message: JsonRecord & { type: string },
  ): Promise<void> {
    const requestedLocalSessionId =
      readNonEmptyString(message.sessionId) ?? `incodex-terminal:${session.id}:${randomUUID()}`;
    const conversationId = readNonEmptyString(message.conversationId);
    const canonicalSessionId =
      session.terminalSessionIdsByLocalSessionId.get(requestedLocalSessionId) ??
      (conversationId ? this.terminalSessionIdsByConversation.get(conversationId) : null) ??
      requestedLocalSessionId;

    const route = this.ensureTerminalRoute(canonicalSessionId, conversationId);
    this.attachBrowserToTerminal(route, session, requestedLocalSessionId);

    await this.options.relay.forwardBridgeMessage({
      ...message,
      sessionId: canonicalSessionId,
      [TERMINAL_TARGET_BROWSER_SESSION_ID_KEY]: session.id,
      [TERMINAL_TARGET_BROWSER_TERMINAL_SESSION_ID_KEY]: requestedLocalSessionId,
    });
  }

  private async handleTerminalControlEnvelope(
    session: BrowserSession,
    message: JsonRecord & { type: string },
  ): Promise<void> {
    const requestedLocalSessionId = readNonEmptyString(message.sessionId);
    if (!requestedLocalSessionId) {
      return;
    }

    const canonicalSessionId =
      session.terminalSessionIdsByLocalSessionId.get(requestedLocalSessionId);
    if (!canonicalSessionId) {
      this.sendTerminalError(
        session.id,
        requestedLocalSessionId,
        "Terminal session is not available.",
      );
      return;
    }

    const route = this.terminalSessionRoutes.get(canonicalSessionId);
    if (!route) {
      this.sendTerminalError(
        session.id,
        requestedLocalSessionId,
        "Terminal session is not available.",
      );
      return;
    }

    this.refreshTerminalOwner(route);
    if (route.ownerBrowserSessionId !== session.id) {
      this.sendTerminalError(
        session.id,
        requestedLocalSessionId,
        "Another browser controls this terminal.",
      );
      return;
    }

    await this.options.relay.forwardBridgeMessage({
      ...message,
      sessionId: canonicalSessionId,
      [TERMINAL_TARGET_BROWSER_SESSION_ID_KEY]: session.id,
      [TERMINAL_TARGET_BROWSER_TERMINAL_SESSION_ID_KEY]: requestedLocalSessionId,
    });
  }

  private ensureTerminalRoute(
    terminalSessionId: string,
    conversationId: string | null,
  ): TerminalSessionRoute {
    let route = this.terminalSessionRoutes.get(terminalSessionId);
    if (!route) {
      route = {
        id: terminalSessionId,
        conversationId,
        ownerBrowserSessionId: null,
        participantOrder: [],
        localSessionIdsByBrowserSessionId: new Map(),
      };
      this.terminalSessionRoutes.set(terminalSessionId, route);
    }

    if (conversationId) {
      route.conversationId = conversationId;
      this.terminalSessionIdsByConversation.set(conversationId, terminalSessionId);
    }

    return route;
  }

  private attachBrowserToTerminal(
    route: TerminalSessionRoute,
    session: BrowserSession,
    localSessionId: string,
  ): void {
    const previousLocalSessionId = route.localSessionIdsByBrowserSessionId.get(session.id);
    if (previousLocalSessionId && previousLocalSessionId !== localSessionId) {
      session.terminalSessionIdsByLocalSessionId.delete(previousLocalSessionId);
    }

    route.localSessionIdsByBrowserSessionId.set(session.id, localSessionId);
    session.terminalSessionIdsByLocalSessionId.set(localSessionId, route.id);
    if (!route.participantOrder.includes(session.id)) {
      route.participantOrder.push(session.id);
    }
    if (!route.ownerBrowserSessionId) {
      route.ownerBrowserSessionId = session.id;
    }
  }

  private handleTargetedTerminalRelayMessage(message: JsonRecord & { type: string }): boolean {
    const targetBrowserSessionId = readNonEmptyString(
      message[TERMINAL_TARGET_BROWSER_SESSION_ID_KEY],
    );
    if (!targetBrowserSessionId) {
      return false;
    }

    this.sendBridgeMessageToSession(targetBrowserSessionId, stripInternalBridgeFields(message));
    return true;
  }

  private handleTerminalStreamRelayMessage(message: JsonRecord & { type: string }): boolean {
    if (!TERMINAL_STREAM_MESSAGE_TYPES.has(message.type)) {
      return false;
    }

    const canonicalSessionId = readNonEmptyString(message.sessionId);
    if (!canonicalSessionId) {
      return false;
    }

    const route = this.terminalSessionRoutes.get(canonicalSessionId);
    if (!route) {
      return false;
    }

    for (const [browserSessionId, localSessionId] of route.localSessionIdsByBrowserSessionId) {
      this.sendBridgeMessageToSession(browserSessionId, {
        ...stripInternalBridgeFields(message),
        sessionId: localSessionId,
      });
    }

    if (message.type === "terminal-exit") {
      this.deleteTerminalRoute(route);
    }

    return true;
  }

  private sendBridgeMessageToSession(sessionId: string, message: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    this.send(session.socket, {
      type: "bridge_message",
      message,
    });
  }

  private sendTerminalError(
    browserSessionId: string,
    localTerminalSessionId: string,
    message: string,
  ): void {
    this.sendBridgeMessageToSession(browserSessionId, {
      type: "terminal-error",
      sessionId: localTerminalSessionId,
      message,
    });
  }

  private async incrementWorkerSubscribers(workerName: string): Promise<void> {
    const count = this.workerSubscriberCounts.get(workerName) ?? 0;
    if (count === 0) {
      await this.options.relay.subscribeWorker(workerName);
    }
    this.workerSubscriberCounts.set(workerName, count + 1);
  }

  private async decrementWorkerSubscribers(workerName: string): Promise<void> {
    const count = this.workerSubscriberCounts.get(workerName) ?? 0;
    if (count <= 1) {
      this.workerSubscriberCounts.delete(workerName);
      if (count === 1) {
        await this.options.relay.unsubscribeWorker(workerName);
      }
      return;
    }

    this.workerSubscriberCounts.set(workerName, count - 1);
  }

  private cleanupSession(session: BrowserSession): void {
    this.sessions.delete(session.id);
    for (const workerName of session.subscribedWorkers) {
      void this.decrementWorkerSubscribers(workerName);
    }

    for (const [localSessionId, terminalSessionId] of session.terminalSessionIdsByLocalSessionId) {
      session.terminalSessionIdsByLocalSessionId.delete(localSessionId);
      this.detachBrowserFromTerminal(terminalSessionId, session.id);
    }
  }

  private detachBrowserFromTerminal(terminalSessionId: string, browserSessionId: string): void {
    const route = this.terminalSessionRoutes.get(terminalSessionId);
    if (!route) {
      return;
    }

    route.localSessionIdsByBrowserSessionId.delete(browserSessionId);
    route.participantOrder = route.participantOrder.filter(
      (sessionId) => sessionId !== browserSessionId,
    );

    if (route.ownerBrowserSessionId === browserSessionId) {
      route.ownerBrowserSessionId = route.participantOrder[0] ?? null;
    }

    if (route.localSessionIdsByBrowserSessionId.size === 0) {
      this.deleteTerminalRoute(route);
    }
  }

  private deleteTerminalRoute(route: TerminalSessionRoute): void {
    this.terminalSessionRoutes.delete(route.id);
    if (
      route.conversationId &&
      this.terminalSessionIdsByConversation.get(route.conversationId) === route.id
    ) {
      this.terminalSessionIdsByConversation.delete(route.conversationId);
    }

    for (const [browserSessionId, localSessionId] of route.localSessionIdsByBrowserSessionId) {
      const session = this.sessions.get(browserSessionId);
      session?.terminalSessionIdsByLocalSessionId.delete(localSessionId);
    }
  }

  private refreshTerminalOwner(route: TerminalSessionRoute): void {
    if (route.ownerBrowserSessionId && this.isSessionActive(route.ownerBrowserSessionId)) {
      return;
    }

    route.participantOrder = route.participantOrder.filter((sessionId) => {
      const session = this.sessions.get(sessionId);
      return session
        ? route.localSessionIdsByBrowserSessionId.has(session.id) &&
            session.socket.readyState === WebSocket.OPEN
        : false;
    });
    route.ownerBrowserSessionId = route.participantOrder[0] ?? null;
  }

  private isSessionActive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.socket.readyState === WebSocket.OPEN;
  }

  private broadcast(envelope: ServerToBrowserEnvelope): void {
    for (const session of this.sessions.values()) {
      this.send(session.socket, envelope);
    }
  }

  private handleHeartbeatTick(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (now - session.lastHeartbeatAckAt > this.heartbeatTimeoutMs) {
        debugLog("server", "closing stale browser session", {
          sessionId: session.id,
          idleMs: now - session.lastHeartbeatAckAt,
        });
        session.socket.close(4000, "heartbeat-timeout");
        continue;
      }

      this.send(session.socket, {
        type: "heartbeat",
        sentAt: now,
      });
    }
  }

  private send(socket: WebSocket, envelope: ServerToBrowserEnvelope): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(envelope));
  }

  private getIndexHtml(): Promise<string> {
    if (!this.indexHtmlPromise) {
      this.indexHtmlPromise = this.options.renderIndexHtml();
    }
    return this.indexHtmlPromise;
  }

  private getServiceWorkerScript(): Promise<string> {
    if (!this.serviceWorkerScriptPromise) {
      this.serviceWorkerScriptPromise = this.options.renderServiceWorkerScript();
    }
    return this.serviceWorkerScriptPromise;
  }

  private getWebManifest(): Promise<string> {
    if (!this.webManifestPromise) {
      this.webManifestPromise = this.options.renderWebManifest();
    }
    return this.webManifestPromise;
  }

  private getProtocol(): "http" | "https" {
    return this.options.protocol ?? (this.options.tls ? "https" : "http");
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function extractRequestId(payload: unknown): string {
  return typeof payload === "object" &&
    payload !== null &&
    "requestId" in payload &&
    typeof payload.requestId === "string"
    ? payload.requestId
    : "";
}

function extractMethod(payload: unknown): string {
  return typeof payload === "object" &&
    payload !== null &&
    "method" in payload &&
    typeof payload.method === "string"
    ? payload.method
    : "";
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function isTerminalBridgeMessage(message: unknown): message is JsonRecord & { type: string } {
  return (
    isJsonRecord(message) &&
    typeof message.type === "string" &&
    (TERMINAL_ATTACH_MESSAGE_TYPES.has(message.type) ||
      TERMINAL_CONTROL_MESSAGE_TYPES.has(message.type))
  );
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const ASYNC_BRIDGE_RELAY_MESSAGE_TYPES = new Set([
  "fetch",
  "cancel-fetch",
  "fetch-stream",
  "cancel-fetch-stream",
  "mcp-request",
  "mcp-response",
  "mcp-notification",
  "log-message",
]);

function isAsyncBridgeRelayMessage(message: unknown): boolean {
  return (
    isJsonRecord(message) &&
    typeof message.type === "string" &&
    ASYNC_BRIDGE_RELAY_MESSAGE_TYPES.has(message.type)
  );
}

function stripInternalBridgeFields(message: JsonRecord): JsonRecord {
  const {
    [TERMINAL_TARGET_BROWSER_SESSION_ID_KEY]: _browserSessionId,
    [TERMINAL_TARGET_BROWSER_TERMINAL_SESSION_ID_KEY]: _browserTerminalSessionId,
    ...rest
  } = message;
  return rest;
}

function shouldServeSpaShell(method: string | undefined, pathname: string): boolean {
  if (method && method !== "GET" && method !== "HEAD") {
    return false;
  }

  const lastPathSegment = pathname.split("/").at(-1) ?? "";
  return !lastPathSegment.includes(".");
}

function maybePatchCodexWebviewScript(pathname: string, fileBuffer: Buffer): string | null {
  if (!/^\/assets\/(?:index|app-main|rpc)-[\w-]+\.js$/.test(pathname)) {
    return null;
  }

  const source = fileBuffer.toString("utf8");
  if (/^\/assets\/rpc-[\w-]+\.js$/.test(pathname)) {
    return maybePatchCodexRpcScript(pathname, source);
  }

  if (!isDebugEnabled("entry")) {
    return null;
  }

  if (/^\/assets\/app-main-[\w-]+\.js$/.test(pathname)) {
    return maybePatchCodexAppMainScript(pathname, source);
  }

  const withRpcStart = source.replace(
    "await e(()=>import(`./rpc-",
    'console.info("[incodex:entry] import rpc start");try{await e(()=>import(`./rpc-',
  );
  const withAppStart = withRpcStart.replace(
    ",await e(()=>import(`./app-main-",
    ';console.info("[incodex:entry] import rpc done");}catch(error){console.error("[incodex:entry] import rpc failed",error);throw error}console.info("[incodex:entry] import app-main start");try{await e(()=>import(`./app-main-',
  );
  const patched = withAppStart.replace(
    /;\n\/\/# sourceMappingURL=/,
    ';console.info("[incodex:entry] import app-main done");}catch(error){console.error("[incodex:entry] import app-main failed",error);throw error}setTimeout(()=>{console.info("[incodex:entry] root snapshot",{bodyText:document.body?.innerText?.slice(0,500)??"",rootHtml:document.getElementById("root")?.innerHTML?.slice(0,1000)??null,electronBridgeKeys:Object.keys(window.electronBridge??{}),codexWindowType:window.codexWindowType});},1000);\n//# sourceMappingURL=',
  );

  if (patched === source) {
    debugLog("entry", "failed to patch Codex entry script", { pathname });
    return null;
  }

  debugLog("entry", "serving patched Codex entry script", { pathname });
  return patched;
}

function maybePatchCodexAppMainScript(pathname: string, source: string): string | null {
  const targetPattern =
    /async function ([A-Za-z0-9_$]+)\(\)\{await ([A-Za-z0-9_$]+)\(\),await ([A-Za-z0-9_$]+)\(\),([A-Za-z0-9_$]+)\.render\(\(0,([A-Za-z0-9_$]+)\.jsx\)\(\$\.StrictMode,\{children:\(0,\5\.jsx\)\(([A-Za-z0-9_$]+),\{name:`App`,fallback:\(0,\5\.jsx\)\(([A-Za-z0-9_$]+),\{\}\),children:\(0,\5\.jsx\)\(([A-Za-z0-9_$]+),\{\}\)\}\)\}\)\)\}async function ([A-Za-z0-9_$]+)\(\)\{\}/;
  const patched = source.replace(
    targetPattern,
    (
      _match,
      bootstrapFn,
      firstInitFn,
      secondInitFn,
      reactRootVar,
      jsxNamespace,
      appComponent,
      fallbackComponent,
      shellComponent,
      trailingInitFn,
    ) =>
      `async function ${bootstrapFn}(){console.info("[incodex:entry] app-main bootstrap start");try{console.info("[incodex:entry] ${firstInitFn} start");await ${firstInitFn}();console.info("[incodex:entry] ${firstInitFn} done");console.info("[incodex:entry] ${secondInitFn} start");let __incodexInitTimer=setTimeout(()=>console.warn("[incodex:entry] ${secondInitFn} still pending after 5000ms"),5000);await ${secondInitFn}();clearTimeout(__incodexInitTimer);console.info("[incodex:entry] ${secondInitFn} done");console.info("[incodex:entry] react render start");${reactRootVar}.render((0,${jsxNamespace}.jsx)($.StrictMode,{children:(0,${jsxNamespace}.jsx)(${appComponent},{name:\`App\`,fallback:(0,${jsxNamespace}.jsx)(${fallbackComponent},{}),children:(0,${jsxNamespace}.jsx)(${shellComponent},{})})}));console.info("[incodex:entry] react render called");setTimeout(()=>console.info("[incodex:entry] post-render root",{bodyText:document.body?.innerText?.slice(0,500)??"",rootHtml:document.getElementById("root")?.innerHTML?.slice(0,1000)??null}),1000)}catch(error){console.error("[incodex:entry] app-main bootstrap failed",error);throw error}}async function ${trailingInitFn}(){}`,
  );

  if (patched === source) {
    debugLog("entry", "failed to patch Codex app-main script", { pathname });
    return null;
  }

  debugLog("entry", "serving patched Codex app-main script", { pathname });
  return patched;
}

function maybePatchCodexRpcScript(pathname: string, source: string): string | null {
  const targetPattern =
    /function ([A-Za-z0-9_$]+)\(\)\{let\{port1:([A-Za-z0-9_$]+),port2:([A-Za-z0-9_$]+)\}=new MessageChannel;return window\.postMessage\(\{type:`connect-app-host`,port:\3\},window\.location\.origin,\[\3\]\),([A-Za-z0-9_$]+)\(\2,([A-Za-z0-9_$]+)\)\}/;
  let patched = source.replace(
    targetPattern,
    (_match, fnName, port1Name, port2Name, rpcFactoryName, appHostVar) =>
      `function ${fnName}(){let{port1:${port1Name},port2:${port2Name}}=new MessageChannel,__incodexLoopback=${rpcFactoryName}(${port2Name},${appHostVar});return(globalThis.__incodexAppHostLoopbacks||(globalThis.__incodexAppHostLoopbacks=[])).push(__incodexLoopback),${rpcFactoryName}(${port1Name},${appHostVar})}`,
  );

  const requestUserInputAutoResolutionPattern =
    /async function ([A-Za-z0-9_$]+)\(\)\{\$=([A-Za-z0-9_$]+)\(\),([A-Za-z0-9_$]+)=await \$\.services\}/;
  patched = patched.replace(
    requestUserInputAutoResolutionPattern,
    (_match, initFnName, connectFnName, servicesVarName) =>
      `async function ${initFnName}(){$=${connectFnName}(),${servicesVarName}=await $.services,${servicesVarName}.requestUserInputAutoResolution??={setConversationPresented(){},recordConversationActivity(){},snooze(){}}}`,
  );

  if (patched === source) {
    debugLog("entry", "failed to patch Codex RPC app-host loopback", { pathname });
    return null;
  }

  debugLog("entry", "serving patched Codex RPC app-host loopback", { pathname });
  return patched;
}

function sanitizeBrowserUploadFilename(value: string): string {
  const filename = basename(value)
    .replace(/[^\w .()-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return filename || "attachment";
}
