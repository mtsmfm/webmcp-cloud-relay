/**
 * MAIN-world reader, injected at document_start.
 *
 * A pure subscriber: it never defines document.modelContext or any other web
 * API. If the page has WebMCP — native, or a page-shipped polyfill (which
 * only the MAIN world can see, hence this world) — the reader subscribes to
 * toolchange, lists tools with getTools(), and runs them with executeTool(),
 * relaying over window.postMessage to the isolated-world content script. On
 * pages without WebMCP it stays silent and touches nothing.
 */

import type { ExtensionToPage, PageToExtension, RawTool } from "./messages";
import { WINDOW_SOURCE } from "./messages";

/** The spec's caller side (getTools / executeTool / toolchange). */
interface CallerModelContext {
  getTools(): Promise<
    {
      name: string;
      description: string;
      /** Chrome's native implementation returns this as a JSON string. */
      inputSchema?: object | string;
      annotations?: RawTool["annotations"];
    }[]
  >;
  /** The spec's caller side takes the input arguments as a JSON string. */
  executeTool(tool: { name: string }, args: string): Promise<unknown>;
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

  /**
   * Native implementations serialize the execute() return value to a JSON
   * string; undo that so MCP clients see the value, not a double-encoded
   * string. A plain non-JSON string (a polyfill's) passes through as-is.
   */
  const parseResult = (out: unknown): unknown => {
    if (typeof out !== "string") return toCloneable(out);
    try {
      return JSON.parse(out);
    } catch {
      return out;
    }
  };

  /** Normalize inputSchema to an object: native Chrome returns a string. */
  const parseSchema = (
    schema: object | string | undefined,
  ): Record<string, unknown> | undefined => {
    if (typeof schema !== "string") {
      return schema as Record<string, unknown> | undefined;
    }
    try {
      const parsed: unknown = JSON.parse(schema);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  };

  const announce = async () => {
    if (!mc) return;
    const tools = await mc.getTools();
    const descriptors: RawTool[] = tools.map((t) => {
      const inputSchema = parseSchema(t.inputSchema);
      return {
        name: t.name,
        description: t.description,
        ...(inputSchema ? { inputSchema } : {}),
        ...(t.annotations ? { annotations: t.annotations } : {}),
      };
    });
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
      const out = await mc.executeTool(tool, JSON.stringify(msg.args ?? {}));
      post({
        source: WINDOW_SOURCE,
        dir: "page",
        type: "result",
        id: msg.id,
        ok: true,
        content: parseResult(out),
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
