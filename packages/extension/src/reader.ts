/**
 * MAIN-world reader, injected at document_start.
 *
 * This script is a pure subscriber: it never defines document.modelContext
 * or any other web API. If the page has WebMCP — a native implementation, or
 * a spec-shaped polyfill the page shipped itself — the reader subscribes to
 * toolchange, lists tools with getTools(), and runs them with executeTool(),
 * relaying over window.postMessage to the extension's isolated-world content
 * script (which cannot see MAIN-world JavaScript). On pages without WebMCP
 * it stays silent and touches nothing.
 *
 * It runs in the MAIN world because a page-shipped polyfill is MAIN-world
 * JavaScript, invisible from the isolated world; a native implementation
 * would be visible from either.
 */

import type { ExtensionToPage, PageToExtension, RawTool } from "./messages";
import { WINDOW_SOURCE } from "./messages";

/** The spec's caller side (getTools / executeTool / toolchange). */
interface CallerModelContext {
  getTools(): Promise<
    {
      name: string;
      description: string;
      inputSchema?: object;
      annotations?: RawTool["annotations"];
    }[]
  >;
  executeTool(
    tool: { name: string },
    args: Record<string, unknown>,
  ): Promise<unknown>;
  addEventListener(type: "toolchange", listener: () => void): void;
}

/** How long to keep checking for a late-loading page polyfill. */
const DISCOVERY_INTERVAL_MS = 500;
const DISCOVERY_MAX_TRIES = 20;

(() => {
  if (window !== window.top) return; // top frame only in v1
  // Injected on demand, possibly repeatedly; keep a single instance.
  const w = window as Window & { __webmcpCloudRelayReader?: boolean };
  if (w.__webmcpCloudRelayReader) return;
  w.__webmcpCloudRelayReader = true;

  let mc: CallerModelContext | null = null;

  const post = (msg: PageToExtension) => window.postMessage(msg, "*");

  const toCloneable = (value: unknown): unknown => {
    if (value === undefined) return null;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  };

  const announce = async () => {
    if (!mc) return;
    const tools = await mc.getTools();
    const descriptors: RawTool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      ...(t.inputSchema
        ? { inputSchema: t.inputSchema as Record<string, unknown> }
        : {}),
      ...(t.annotations ? { annotations: t.annotations } : {}),
    }));
    post({
      source: WINDOW_SOURCE,
      dir: "page",
      type: "tools",
      tools: descriptors,
    });
  };

  /**
   * Native implementations exist at document_start; page polyfills appear
   * whenever the page's own scripts run, so keep looking for a while.
   */
  const discover = (): boolean => {
    if (mc) return true;
    const cand = (document as { modelContext?: Partial<CallerModelContext> })
      .modelContext;
    // Without the caller side there is nothing we can do with the tools.
    if (
      !cand ||
      typeof cand.getTools !== "function" ||
      typeof cand.executeTool !== "function"
    ) {
      return false;
    }
    mc = cand as CallerModelContext;
    mc.addEventListener("toolchange", () => void announce());
    void announce();
    return true;
  };

  const handleCall = async (
    msg: Extract<ExtensionToPage, { type: "call" }>,
  ) => {
    try {
      if (!mc) throw new Error("This page does not provide WebMCP");
      const tools = await mc.getTools();
      const tool = tools.find((t) => t.name === msg.name);
      if (!tool) throw new Error(`Unknown tool: ${msg.name}`);
      const out = await mc.executeTool(tool, msg.args);
      post({
        source: WINDOW_SOURCE,
        dir: "page",
        type: "result",
        id: msg.id,
        ok: true,
        content: toCloneable(out),
      });
    } catch (e) {
      const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      post({
        source: WINDOW_SOURCE,
        dir: "page",
        type: "result",
        id: msg.id,
        ok: false,
        error,
      });
    }
  };

  window.addEventListener("message", (event: MessageEvent) => {
    const msg = event.data as ExtensionToPage;
    if (
      event.source !== window ||
      !msg ||
      msg.source !== WINDOW_SOURCE ||
      msg.dir !== "ext"
    )
      return;
    if (msg.type === "announce") {
      if (discover()) void announce();
    } else if (msg.type === "call") {
      void handleCall(msg);
    }
  });

  discover();
  document.addEventListener("DOMContentLoaded", discover);
  window.addEventListener("load", discover);
  let tries = 0;
  const timer = setInterval(() => {
    if (discover() || ++tries >= DISCOVERY_MAX_TRIES) clearInterval(timer);
  }, DISCOVERY_INTERVAL_MS);
})();
