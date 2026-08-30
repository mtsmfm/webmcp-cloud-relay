/**
 * Isolated-world content script: relays between the MAIN-world reader
 * (window.postMessage) and the service worker (chrome.runtime Port).
 * Reconnects the port when the service worker is restarted.
 */

import type {
  ContentToSw,
  ExtensionToPage,
  PageToExtension,
  SwToContent,
} from "./messages";
import { WINDOW_SOURCE } from "./messages";

// Injected on demand (activeTab click or a per-site registration), possibly
// more than once for the same document — the guard keeps one instance.
const w = window as Window & { __webmcpCloudRelayContent?: boolean };

if (window === window.top && !w.__webmcpCloudRelayContent) {
  w.__webmcpCloudRelayContent = true;
  let port: chrome.runtime.Port | null = null;

  const toPage = (msg: ExtensionToPage) => window.postMessage(msg, "*");

  const toSw = (msg: ContentToSw) => {
    try {
      port?.postMessage(msg);
    } catch {
      port = null;
    }
  };

  window.addEventListener("message", (event: MessageEvent) => {
    const msg = event.data as PageToExtension;
    if (
      event.source !== window ||
      !msg ||
      msg.source !== WINDOW_SOURCE ||
      msg.dir !== "page"
    )
      return;
    if (msg.type === "tools") {
      toSw({ type: "tools", tools: msg.tools });
    } else if (msg.type === "result") {
      toSw({
        type: "result",
        id: msg.id,
        ok: msg.ok,
        content: msg.content,
        error: msg.error,
      });
    }
  });

  const connect = () => {
    try {
      port = chrome.runtime.connect({ name: "webmcp" });
    } catch {
      return; // extension was unloaded
    }
    port.onMessage.addListener((msg: SwToContent) => {
      if (msg.type === "call") {
        toPage({
          source: WINDOW_SOURCE,
          dir: "ext",
          type: "call",
          id: msg.id,
          name: msg.name,
          args: msg.args,
        });
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connect, 500);
    });
    toSw({ type: "hello", origin: window.origin });
    // Ask the reader for the current snapshot so a fresh service worker (or a
    // re-established port) learns about tools registered earlier.
    toPage({ source: WINDOW_SOURCE, dir: "ext", type: "announce" });
  };

  connect();
}
