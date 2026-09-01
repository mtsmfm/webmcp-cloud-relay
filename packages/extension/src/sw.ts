/**
 * Service worker: holds per-tab grants, composes the namespaced tool set
 * from granted tabs, and speaks the bridge protocol to the relay over an
 * outbound WebSocket.
 *
 * Lifetime notes (MV3): all state that must survive a service-worker restart
 * lives in chrome.storage (grants in .session, settings in .local); the tab
 * registry is rebuilt when content scripts reconnect their ports. WebSocket
 * traffic (20s pings) keeps the worker alive while a bridge is active.
 */

import type {
  ExtensionToRelay,
  RelayToExtension,
  ToolDescriptor,
} from "@webmcp-cloud-relay/protocol";
import type {
  BridgeState,
  ContentToSw,
  PopupRequest,
  RawTool,
  SwToContent,
  TabState,
} from "./messages";

const PING_INTERVAL_MS = 20_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

interface TabEntry {
  origin: string;
  tools: RawTool[];
  port: chrome.runtime.Port;
}

interface Settings {
  relayUrl: string | null;
  token: string | null;
}

const tabs = new Map<number, TabEntry>();
/** exposed MCP name -> where to route the call */
let exposedRoutes = new Map<string, { tabId: number; raw: string }>();
let exposedTools: ToolDescriptor[] = [];

// ---- persistent state ----

/** The hosted relay; clearing the relay URL in settings returns to it. */
const DEFAULT_RELAY_URL = "https://relay.webmcp-cloud-relay.workers.dev";

/** What storage holds: relayUrl null means "use the default". */
async function getRawSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings");
  return { relayUrl: null, token: null, ...(settings ?? {}) };
}

/** Settings with the default relay applied; storage stays sparse so a
 * future default change reaches users who never set their own URL. */
async function getSettings(): Promise<Settings & { relayUrl: string }> {
  const raw = await getRawSettings();
  return { ...raw, relayUrl: raw.relayUrl ?? DEFAULT_RELAY_URL };
}

async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getRawSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

async function ensureToken(): Promise<string> {
  const settings = await getSettings();
  if (settings.token) return settings.token;
  return (await patchSettings({ token: generateToken() })).token!;
}

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** Grants survive service-worker restarts but not a browser restart. */
async function getGrants(): Promise<Map<number, string>> {
  const { grants } = await chrome.storage.session.get("grants");
  return new Map(
    Object.entries(grants ?? {}).map(([k, v]) => [Number(k), v as string]),
  );
}

async function setGrants(grants: Map<number, string>): Promise<void> {
  await chrome.storage.session.set({ grants: Object.fromEntries(grants) });
}

// ---- tool composition ----

function originSlug(origin: string): string {
  try {
    return new URL(origin).hostname
      .replace(/^www\./, "")
      .replace(/[^A-Za-z0-9]+/g, "_");
  } catch {
    return "page";
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 128);
}

function composeTools(grants: Map<number, string>): void {
  exposedRoutes = new Map();
  exposedTools = [];
  for (const [tabId, entry] of tabs) {
    if (!grants.has(tabId)) continue;
    const slug = originSlug(entry.origin);
    for (const t of entry.tools) {
      const base = sanitizeName(`${slug}_${t.name}`);
      let name = base;
      for (let n = 2; exposedRoutes.has(name); n++) name = `${base}_${n}`;
      exposedRoutes.set(name, { tabId, raw: t.name });
      exposedTools.push({
        name,
        description: t.description,
        ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
        // Forced last so a page can never declare its own output trustworthy.
        annotations: { ...t.annotations, untrustedContentHint: true },
      });
    }
  }
}

// ---- relay WebSocket ----

let ws: WebSocket | null = null;
let wsWanted = false;
let backoffMs = BACKOFF_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Tool results the socket could not carry (closed, or replaced mid-call).
 * Flushed on the next open: the relay keeps a call pending for 120s, so a
 * result delivered after a quick reconnect still completes the call.
 */
const queuedResults: ExtensionToRelay[] = [];
const QUEUED_RESULTS_MAX = 32;

function sendToRelay(msg: ExtensionToRelay): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else if (msg.type === "result") {
    queuedResults.push(msg);
    if (queuedResults.length > QUEUED_RESULTS_MAX) queuedResults.shift();
  }
}

async function ensureWs(): Promise<void> {
  const settings = await getSettings();
  wsWanted = exposedTools.length > 0 && !!settings.token;
  if (!wsWanted) {
    teardownWs();
    return;
  }
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  )
    return;
  const base = settings.relayUrl.replace(/^http/, "ws");
  let socket: WebSocket;
  try {
    socket = new WebSocket(`${base}/t/${settings.token}/ws`);
  } catch {
    scheduleReconnect();
    return;
  }
  // Handlers act on their own socket and stand down once it is no longer the
  // current one, so a superseded connection can never close or speak for its
  // replacement.
  ws?.close();
  ws = socket;
  socket.onopen = () => {
    if (socket !== ws) {
      socket.close();
      return;
    }
    backoffMs = BACKOFF_MIN_MS;
    sendToRelay({ type: "tools", tools: exposedTools });
    for (const msg of queuedResults.splice(0)) sendToRelay(msg);
    pingTimer ??= setInterval(
      () => ws?.readyState === WebSocket.OPEN && ws.send("ping"),
      PING_INTERVAL_MS,
    );
  };
  socket.onmessage = (event) => {
    if (socket !== ws) return;
    if (typeof event.data !== "string" || event.data === "pong") return;
    let msg: RelayToExtension;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "call") routeCall(msg);
  };
  socket.onclose = () => {
    if (socket !== ws) return;
    ws = null;
    if (wsWanted) scheduleReconnect();
  };
  socket.onerror = () => socket.close();
}

function teardownWs(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
  // Queued results belong to the bridge being torn down, not the next one.
  queuedResults.length = 0;
  ws?.close();
  ws = null;
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void ensureWs();
  }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
}

function routeCall(msg: RelayToExtension): void {
  const route = exposedRoutes.get(msg.name);
  const entry = route && tabs.get(route.tabId);
  if (!route || !entry) {
    sendToRelay({
      type: "result",
      id: msg.id,
      ok: false,
      error: `Tool is gone: ${msg.name}`,
    });
    return;
  }
  const call: SwToContent = {
    type: "call",
    id: msg.id,
    name: route.raw,
    args: msg.args,
  };
  try {
    entry.port.postMessage(call);
  } catch {
    sendToRelay({
      type: "result",
      id: msg.id,
      ok: false,
      error: "The granted tab went away",
    });
  }
}

// ---- grants & badges ----

async function grantTab(tabId: number): Promise<void> {
  const entry = tabs.get(tabId);
  if (!entry) return;
  const grants = await getGrants();
  // One active tab per origin keeps tool names stable and unambiguous.
  for (const [otherId, origin] of grants) {
    if (otherId !== tabId && origin === entry.origin) grants.delete(otherId);
  }
  grants.set(tabId, entry.origin);
  await setGrants(grants);
  await sync();
}

async function revokeTab(tabId: number): Promise<void> {
  const grants = await getGrants();
  if (grants.delete(tabId)) await setGrants(grants);
  await sync();
}

async function updateBadges(grants: Map<number, string>): Promise<void> {
  for (const [tabId, entry] of tabs) {
    const granted = grants.has(tabId);
    const text = granted
      ? "ON"
      : entry.tools.length > 0
        ? String(entry.tools.length)
        : "";
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color: granted ? "#1a7f37" : "#1a66c2",
    });
  }
}

/** Recompose tools, refresh badges, push the snapshot, adjust the socket. */
async function sync(): Promise<void> {
  const grants = await getGrants();
  composeTools(grants);
  await updateBadges(grants);
  sendToRelay({ type: "tools", tools: exposedTools });
  await ensureWs();
}

// ---- on-demand injection ----
//
// Nothing is injected anywhere by default: opening the popup on a tab (an
// activeTab grant) injects the reader + content script into that tab.

async function ensureInjected(tabId: number): Promise<void> {
  if (tabs.has(tabId)) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["reader.js"],
      world: "MAIN",
      injectImmediately: true,
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
      injectImmediately: true,
    });
  } catch {
    return; // a page we cannot touch (chrome://, the web store, no permission)
  }
  // Give the fresh content script a moment to connect and report.
  for (let i = 0; i < 14 && !tabs.has(tabId); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---- content script ports ----

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "webmcp") return;
  const tabId = port.sender?.tab?.id;
  if (tabId === undefined) return;
  let entry: TabEntry | null = null;

  port.onMessage.addListener((msg: ContentToSw) => {
    if (msg.type === "hello") {
      entry = { origin: msg.origin, tools: [], port };
      tabs.set(tabId, entry);
      void sync();
      return;
    }
    if (!entry) return;
    const origin = entry.origin;
    if (msg.type === "tools") {
      entry.tools = msg.tools;
      void (async () => {
        const grants = await getGrants();
        const granted = grants.get(tabId);
        if (granted && granted !== origin) {
          // Same tab navigated to a different site: the grant does not follow.
          grants.delete(tabId);
          await setGrants(grants);
        }
        await sync();
      })();
    } else if (msg.type === "result") {
      sendToRelay(
        msg.ok
          ? { type: "result", id: msg.id, ok: true, content: msg.content }
          : {
              type: "result",
              id: msg.id,
              ok: false,
              error: msg.error ?? "Tool failed",
            },
      );
    }
  });

  port.onDisconnect.addListener(() => {
    if (tabs.get(tabId) === entry) tabs.delete(tabId);
    void sync();
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  void revokeTab(tabId);
});

// ---- popup API ----

async function buildState(tabId: number): Promise<BridgeState> {
  const settings = await getSettings();
  const token = await ensureToken();
  const grants = await getGrants();
  const entry = tabs.get(tabId);
  const tab: TabState | null = entry
    ? {
        tabId,
        origin: entry.origin,
        tools: entry.tools,
        granted: grants.has(tabId),
      }
    : null;
  return {
    relayUrl: settings.relayUrl,
    mcpUrl: `${settings.relayUrl}/t/${token}/mcp`,
    wsConnected: ws?.readyState === WebSocket.OPEN,
    exposedTools,
    tab,
  };
}

chrome.runtime.onMessage.addListener(
  (msg: PopupRequest, _sender, sendResponse) => {
    void (async () => {
      switch (msg.type) {
        case "get-state":
          await ensureInjected(msg.tabId);
          break;
        case "grant":
          await grantTab(msg.tabId);
          break;
        case "revoke":
          await revokeTab(msg.tabId);
          break;
        case "set-relay-url": {
          const url = msg.url.trim().replace(/\/+$/, "");
          // Clear the snapshot the old bridge stores before abandoning it, so
          // the old MCP URL stops listing tools, not just calling them.
          sendToRelay({ type: "tools", tools: [] });
          await patchSettings({ relayUrl: url || null });
          teardownWs();
          await sync();
          break;
        }
        case "regenerate-token":
          sendToRelay({ type: "tools", tools: [] });
          await patchSettings({ token: generateToken() });
          teardownWs();
          await sync();
          break;
      }
      const tabId = "tabId" in msg ? msg.tabId : await activeTabId();
      sendResponse(await buildState(tabId ?? -1));
    })();
    return true; // async response
  },
);

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

chrome.runtime.onInstalled.addListener(() => void ensureToken());
