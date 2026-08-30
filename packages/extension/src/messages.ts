import type { ToolDescriptor } from "@webmcp-cloud-relay/protocol";

/** A tool as the page registered it, before the extension namespaces it. */
export interface RawTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
}

// ---- window.postMessage between the MAIN-world reader and the content script ----
//
// Internal to the extension: both ends are extension code. The MAIN-world
// reader exists because a page-shipped polyfill is invisible from the
// isolated world; the reader consumes whatever WebMCP implementation the
// page has and relays it here.

export const WINDOW_SOURCE = "webmcp-cloud-relay";

export type PageToExtension =
  | {
      source: typeof WINDOW_SOURCE;
      dir: "page";
      type: "tools";
      tools: RawTool[];
    }
  | {
      source: typeof WINDOW_SOURCE;
      dir: "page";
      type: "result";
      id: string;
      ok: boolean;
      content?: unknown;
      error?: string;
    };

export type ExtensionToPage =
  | { source: typeof WINDOW_SOURCE; dir: "ext"; type: "announce" }
  | {
      source: typeof WINDOW_SOURCE;
      dir: "ext";
      type: "call";
      id: string;
      name: string;
      args: Record<string, unknown>;
    };

// ---- chrome.runtime Port between the content script and the service worker ----

export type ContentToSw =
  /** First message after connecting: identifies the document. */
  | { type: "hello"; origin: string }
  | { type: "tools"; tools: RawTool[] }
  | {
      type: "result";
      id: string;
      ok: boolean;
      content?: unknown;
      error?: string;
    };

export type SwToContent = {
  type: "call";
  id: string;
  name: string;
  args: Record<string, unknown>;
};

// ---- chrome.runtime messages between the popup and the service worker ----

export interface TabState {
  tabId: number;
  origin: string | null;
  /** Tools the page has registered (raw names). Empty when none detected. */
  tools: RawTool[];
  granted: boolean;
  /** Whether this tab's origin is on the auto-connect list. */
  autoConnect: boolean;
}

export interface BridgeState {
  relayUrl: string | null;
  /** Full MCP endpoint URL to paste into an agent, or null until configured. */
  mcpUrl: string | null;
  wsConnected: boolean;
  /** Tools currently exposed over MCP (namespaced), across all granted tabs. */
  exposedTools: ToolDescriptor[];
  tab: TabState | null;
}

export type PopupRequest =
  | { type: "get-state"; tabId: number }
  | { type: "grant"; tabId: number }
  | { type: "revoke"; tabId: number }
  | { type: "set-auto-connect"; origin: string; enabled: boolean }
  | { type: "set-relay-url"; url: string }
  | { type: "regenerate-token" };

export type PopupResponse = BridgeState;
