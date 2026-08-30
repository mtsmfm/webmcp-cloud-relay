/**
 * Wire protocol between the browser extension and the relay, spoken over a
 * single WebSocket per pairing token. JSON text frames, except the literal
 * "ping"/"pong" frames used for keepalive (answered by the relay without
 * waking the Durable Object).
 */

/** A tool as exposed to MCP clients (already namespaced by the extension). */
export interface ToolDescriptor {
  /** MCP-visible tool name, e.g. "github_com_search_issues". */
  name: string;
  description: string;
  /** JSON Schema for the input object. Defaults to an empty object schema. */
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
}

export type ExtensionToRelay =
  /** Full snapshot of currently exposed tools; replaces the previous set. */
  | { type: "tools"; tools: ToolDescriptor[] }
  /** Result of a tool call previously requested by the relay. */
  | { type: "result"; id: string; ok: true; content: unknown }
  | { type: "result"; id: string; ok: false; error: string };

export type RelayToExtension = {
  type: "call";
  id: string;
  name: string;
  args: Record<string, unknown>;
};

/** Pairing tokens are 32 random bytes, base64url-encoded (43 chars). */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
