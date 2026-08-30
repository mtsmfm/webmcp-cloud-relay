import { describe, expect, it } from "vitest";
import { handleMessage, toContentBlocks, type McpContext } from "../src/mcp";

function ctx(overrides: Partial<McpContext> = {}): McpContext {
  return {
    listTools: async () => [
      {
        name: "example_com_greet",
        description: "Greets",
        inputSchema: { type: "object" },
      },
    ],
    callTool: async () => ({ ok: true, content: { hello: "world" } }),
    ...overrides,
  };
}

describe("handleMessage", () => {
  it("negotiates a supported protocol version", async () => {
    const res = (await handleMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      },
      ctx(),
    )) as any;
    expect(res.result.protocolVersion).toBe("2025-03-26");
    expect(res.result.capabilities.tools.listChanged).toBe(true);
  });

  it("falls back to the newest version for unknown requests", async () => {
    const res = (await handleMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "9999-01-01" },
      },
      ctx(),
    )) as any;
    expect(res.result.protocolVersion).toBe("2025-06-18");
  });

  it("ignores notifications", async () => {
    expect(
      await handleMessage(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        ctx(),
      ),
    ).toBeNull();
  });

  it("lists tools with a default input schema", async () => {
    const res = (await handleMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ctx({ listTools: async () => [{ name: "t", description: "d" }] }),
    )) as any;
    expect(res.result.tools).toEqual([
      { name: "t", description: "d", inputSchema: { type: "object" } },
    ]);
  });

  it("calls a tool and wraps the result as text content", async () => {
    const res = (await handleMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "example_com_greet", arguments: { name: "Jen" } },
      },
      ctx(),
    )) as any;
    expect(res.result.content).toEqual([
      { type: "text", text: '{"hello":"world"}' },
    ]);
    expect(res.result.isError).toBeUndefined();
  });

  it("rejects unknown tools as a protocol error", async () => {
    const res = (await handleMessage(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } },
      ctx(),
    )) as any;
    expect(res.error.code).toBe(-32602);
  });

  it("reports execution failure via isError, not a protocol error", async () => {
    const res = (await handleMessage(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "example_com_greet" },
      },
      ctx({ callTool: async () => ({ ok: false, error: "page exploded" }) }),
    )) as any;
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toBe("page exploded");
  });

  it("answers unknown methods with -32601", async () => {
    const res = (await handleMessage(
      { jsonrpc: "2.0", id: 6, method: "resources/list" },
      ctx(),
    )) as any;
    expect(res.error.code).toBe(-32601);
  });
});

describe("toContentBlocks", () => {
  it("passes strings through and stringifies the rest", () => {
    expect(toContentBlocks("hi")).toEqual([{ type: "text", text: "hi" }]);
    expect(toContentBlocks([1, 2])).toEqual([{ type: "text", text: "[1,2]" }]);
    expect(toContentBlocks(undefined)).toEqual([
      { type: "text", text: "null" },
    ]);
  });
});
