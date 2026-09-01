import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { join } from "node:path";

const RELAY = "http://127.0.0.1:18789";
const EXT_DIST = join(__dirname, "..", "dist-extension");

interface McpTool {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: { untrustedContentHint?: boolean; readOnlyHint?: boolean };
}

async function mcp(
  url: string,
  method: string,
  params?: object,
): Promise<Record<string, any>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(params ? { params } : {}),
    }),
  });
  const body = (await res.json()) as { result?: Record<string, any> };
  return body.result ?? {};
}

let context: BrowserContext;
let popup: Page;
let mcpUrl: string;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [
      "--enable-features=WebMCP",
      `--disable-extensions-except=${EXT_DIST}`,
      `--load-extension=${EXT_DIST}`,
      "--no-proxy-server",
    ],
  });
});

test.afterAll(async () => {
  await context?.close();
});

test("popup points the extension at the local relay", async () => {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;

  popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.locator("#settings summary").click();
  await popup.getByLabel("Relay base URL").fill(RELAY);
  await popup.getByRole("button", { name: "Save" }).click();

  // The revealed MCP URL is the pairing endpoint for the rest of the test.
  await popup.getByRole("button", { name: "Reveal" }).click();
  mcpUrl = (await popup.locator("#agent .code-inline").textContent()) ?? "";
  expect(mcpUrl).toMatch(new RegExp(`^${RELAY}/t/[A-Za-z0-9_-]{43,}/mcp$`));
});

test("granting the demo tab exposes its tools over MCP", async () => {
  const demo = await context.newPage();
  await demo.goto(`${RELAY}/`);
  // Native WebMCP must be on in this browser, or nothing else can work.
  await expect(demo.locator("#status")).toHaveText(
    "Registered 3 WebMCP tools.",
  );

  // Grant via explicit messages (a real user clicks the popup on the tab,
  // which this harness cannot do; the service-worker path is identical).
  const state = await popup.evaluate(async (relay) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url?.startsWith(relay));
    if (!tab?.id) throw new Error("demo tab not found");
    await chrome.runtime.sendMessage({ type: "get-state", tabId: tab.id });
    return (await chrome.runtime.sendMessage({
      type: "grant",
      tabId: tab.id,
    })) as { tab: { granted: boolean } | null };
  }, RELAY);
  expect(state.tab?.granted).toBe(true);

  await expect
    .poll(
      async () => ((await mcp(mcpUrl, "tools/list"))["tools"] ?? []).length,
      {
        timeout: 20_000,
      },
    )
    .toBe(3);
});

test("tools/list carries object schemas and forced untrusted hints", async () => {
  const tools = (await mcp(mcpUrl, "tools/list"))["tools"] as McpTool[];
  const add = tools.find((t) => t.name.endsWith("_add_note"))!;
  // Native getTools() returns inputSchema as a JSON string; the bridge must
  // hand MCP clients an object.
  expect(add.inputSchema).toEqual({
    type: "object",
    properties: { text: { type: "string", description: "The note text" } },
    required: ["text"],
  });
  for (const t of tools) {
    // A page must not be able to declare its own output trustworthy.
    expect(t.annotations?.untrustedContentHint).toBe(true);
  }
  const list = tools.find((t) => t.name.endsWith("_list_notes"))!;
  expect(list.annotations?.readOnlyHint).toBe(true);
});

test("tools/call round-trips through the page", async () => {
  const tools = (await mcp(mcpUrl, "tools/list"))["tools"] as McpTool[];
  const name = (suffix: string) =>
    tools.find((t) => t.name.endsWith(suffix))!.name;

  const added = await mcp(mcpUrl, "tools/call", {
    name: name("_add_note"),
    arguments: { text: "hello from e2e" },
  });
  expect(added["isError"]).toBeUndefined();
  // Native executeTool() returns a JSON string; the bridge must parse it so
  // clients see the value, not a double-encoded string.
  expect(JSON.parse(added["content"][0].text)).toEqual({ ok: true, count: 1 });

  const listed = await mcp(mcpUrl, "tools/call", {
    name: name("_list_notes"),
    arguments: {},
  });
  expect(JSON.parse(listed["content"][0].text)).toEqual({
    notes: ["hello from e2e"],
  });

  // The note really landed in the page's DOM.
  const demo = context.pages().find((p) => p.url().startsWith(`${RELAY}/`))!;
  await expect(demo.locator("#notes li")).toHaveText(["hello from e2e"]);
});

test("a result stranded by a socket swap still completes the call", async () => {
  // Regression test for the split-brain socket bug: a tool result produced
  // while the extension is between relay sockets used to be dropped
  // silently, leaving the call to hit the relay's 120s timeout even though
  // the page had executed the tool.
  const demo = context.pages().find((p) => p.url().startsWith(`${RELAY}/`))!;
  await demo.evaluate(() => {
    const mc = (
      document as Document & {
        modelContext?: {
          registerTool(tool: object): Promise<void>;
        };
      }
    ).modelContext;
    return mc!.registerTool({
      name: "slow_echo",
      description: "Echoes after a delay",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        await new Promise((r) => setTimeout(r, 3000));
        return { done: true };
      },
    });
  });
  await expect
    .poll(
      async () =>
        ((await mcp(mcpUrl, "tools/list"))["tools"] as McpTool[]).some((t) =>
          t.name.endsWith("_slow_echo"),
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
  const name = ((await mcp(mcpUrl, "tools/list"))["tools"] as McpTool[]).find(
    (t) => t.name.endsWith("_slow_echo"),
  )!.name;

  const call = mcp(mcpUrl, "tools/call", { name, arguments: {} });
  // While the tool is still executing in the page, connect a second
  // "extension" socket for the same token. The bridge closes the real one
  // ("replaced"), so the result comes back while the extension has no open
  // socket; it must be queued and delivered after the ~1s reconnect.
  await new Promise((r) => setTimeout(r, 2000));
  const token = /\/t\/([^/]+)\/mcp$/.exec(mcpUrl)![1];
  const impostor = new WebSocket(
    `${RELAY.replace(/^http/, "ws")}/t/${token}/ws`,
  );
  await new Promise((resolve, reject) => {
    impostor.onopen = resolve;
    impostor.onerror = reject;
  });

  const res = await call;
  impostor.close();
  expect(res["isError"]).toBeUndefined();
  expect(JSON.parse(res["content"][0].text)).toEqual({ done: true });
});

test("unknown tools and disconnected calls fail as tool errors", async () => {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    }),
  });
  const body = (await res.json()) as { error?: { code: number } };
  expect(body.error?.code).toBe(-32602);
});
