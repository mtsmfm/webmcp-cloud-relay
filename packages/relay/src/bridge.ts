import type {
  ExtensionToRelay,
  RelayToExtension,
  ToolDescriptor,
} from "@webmcp-cloud-relay/protocol";
import { handleMessage, type JsonRpcMessage, type McpContext } from "./mcp";

/** How long a tools/call waits for the page before giving up. */
const CALL_TIMEOUT_MS = 120_000;
/** SSE comment heartbeat, to keep intermediaries from closing the stream. */
const SSE_HEARTBEAT_MS = 25_000;
// Open SSE streams pin the Durable Object in memory and accrue duration
// billing, so they are the cost-abuse surface: cap how many can be open, how
// long each lives (clients auto-reconnect), and how long they may outlive the
// extension before there is evidently nothing left to stream about.
const SSE_MAX_STREAMS = 4;
const SSE_MAX_LIFETIME_MS = 2 * 60 * 60_000;
const SSE_EXT_ABSENT_CLOSE_MS = 5 * 60_000;
// The tool snapshot survives extension reconnects, but an abandoned bridge
// (token regenerated with the socket already closed, extension uninstalled)
// must not serve stale tool metadata forever: drop it after a day offline.
const SNAPSHOT_TTL_MS = 24 * 60 * 60_000;

const encoder = new TextEncoder();

type PendingResolve = (
  r: { ok: true; content: unknown } | { ok: false; error: string },
) => void;

/**
 * One Durable Object per pairing token (addressed by its SHA-256; the token
 * itself is never stored). Bridges a single extension WebSocket to any number
 * of MCP streamable-HTTP clients.
 *
 * The extension socket uses the hibernation API, so an idle bridge costs
 * nothing; "ping" frames are answered by the runtime without waking the DO.
 */
export class Bridge implements DurableObject {
  private pending = new Map<string, PendingResolve>();
  private sseWriters = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private sseDeadlines = new Map<
    WritableStreamDefaultWriter<Uint8Array>,
    ReturnType<typeof setTimeout>
  >();
  private extAbsentSince: number | null = null;

  constructor(private ctx: DurableObjectState) {
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") return this.connectExtension(request);
    if (url.pathname === "/mcp") {
      if (request.method === "POST") return this.mcpPost(request);
      if (request.method === "GET") return this.mcpSse();
      if (request.method === "DELETE")
        return new Response(null, { status: 200 });
      return new Response("Method not allowed", { status: 405 });
    }
    return new Response("Not found", { status: 404 });
  }

  // ---- Extension side ----

  private connectExtension(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    // Single extension connection: a new one replaces any stale socket.
    for (const ws of this.ctx.getWebSockets("ext")) ws.close(1000, "replaced");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["ext"]);
    void this.ctx.storage.deleteAlarm();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(
    _ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") return;
    let msg: ExtensionToRelay;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (msg.type === "tools") {
      await this.ctx.storage.put("tools", msg.tools);
      this.notifyToolListChanged();
    } else if (msg.type === "result") {
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        resolve(
          msg.ok
            ? { ok: true, content: msg.content }
            : { ok: false, error: msg.error },
        );
      }
    }
  }

  async webSocketClose(): Promise<void> {
    // Keep the tool snapshot: the extension reconnects with backoff and
    // re-sends it; meanwhile tools/call fails fast below. Only when nothing
    // reconnects for a day is the bridge considered abandoned.
    if (this.ctx.getWebSockets("ext").length === 0) {
      await this.ctx.storage.setAlarm(Date.now() + SNAPSHOT_TTL_MS);
    }
  }

  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets("ext").length > 0) return;
    await this.ctx.storage.delete("tools");
    this.notifyToolListChanged();
  }

  // ---- MCP side (streamable HTTP, stateless: no session ids) ----

  private mcpContext(): McpContext {
    return {
      listTools: async () =>
        (await this.ctx.storage.get<ToolDescriptor[]>("tools")) ?? [],
      callTool: (name, args) => this.callTool(name, args),
    };
  }

  private async mcpPost(request: Request): Promise<Response> {
    let body: JsonRpcMessage | JsonRpcMessage[];
    try {
      body = await request.json();
    } catch {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        },
        { status: 400 },
      );
    }
    const ctx = this.mcpContext();
    const messages = Array.isArray(body) ? body : [body];
    const responses = (
      await Promise.all(messages.map((m) => handleMessage(m, ctx)))
    ).filter((r): r is object => r !== null);
    if (responses.length === 0) return new Response(null, { status: 202 });
    return Response.json(Array.isArray(body) ? responses : responses[0]);
  }

  private mcpSse(): Response {
    if (this.sseWriters.size >= SSE_MAX_STREAMS) {
      return new Response("Too many open streams for this bridge", {
        status: 429,
        headers: { "Retry-After": "60" },
      });
    }
    const { readable, writable } = new TransformStream<
      Uint8Array,
      Uint8Array
    >();
    const writer = writable.getWriter();
    this.sseWriters.add(writer);
    this.sseDeadlines.set(
      writer,
      setTimeout(() => this.closeWriter(writer), SSE_MAX_LIFETIME_MS),
    );
    writer
      .write(encoder.encode(": connected\n\n"))
      .catch(() => this.dropWriter(writer));
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => this.tickSse(), SSE_HEARTBEAT_MS);
    }
    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  }

  /** Heartbeat all streams; close them when the extension stays gone. */
  private tickSse(): void {
    if (this.ctx.getWebSockets("ext").length > 0) {
      this.extAbsentSince = null;
    } else {
      this.extAbsentSince ??= Date.now();
      if (Date.now() - this.extAbsentSince >= SSE_EXT_ABSENT_CLOSE_MS) {
        for (const w of [...this.sseWriters]) this.closeWriter(w);
        return;
      }
    }
    for (const w of this.sseWriters) {
      w.write(encoder.encode(": hb\n\n")).catch(() => this.dropWriter(w));
    }
  }

  private closeWriter(writer: WritableStreamDefaultWriter<Uint8Array>): void {
    writer.close().catch(() => {});
    this.dropWriter(writer);
  }

  private dropWriter(writer: WritableStreamDefaultWriter<Uint8Array>): void {
    this.sseWriters.delete(writer);
    const deadline = this.sseDeadlines.get(writer);
    if (deadline) clearTimeout(deadline);
    this.sseDeadlines.delete(writer);
    if (this.sseWriters.size === 0 && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private notifyToolListChanged(): void {
    const frame = encoder.encode(
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
      })}\n\n`,
    );
    for (const w of this.sseWriters) {
      w.write(frame).catch(() => this.dropWriter(w));
    }
  }

  private callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: true; content: unknown } | { ok: false; error: string }> {
    const ext = this.ctx.getWebSockets("ext")[0];
    if (!ext) {
      return Promise.resolve({
        ok: false,
        error:
          "The browser extension is not connected. Open the granted tab and check the extension.",
      });
    }
    const id = crypto.randomUUID();
    const call: RelayToExtension = { type: "call", id, name, args };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          ok: false,
          error: `Tool call timed out after ${CALL_TIMEOUT_MS / 1000}s`,
        });
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      ext.send(JSON.stringify(call));
    });
  }
}
