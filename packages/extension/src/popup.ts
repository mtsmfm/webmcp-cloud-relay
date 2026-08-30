/**
 * Popup UI.
 *
 * Every request to the service worker resolves with a fresh BridgeState, so
 * the UI is rendered as a pure function of the latest response; the only
 * local state is presentational (whether the secret URL is revealed).
 */

import type { BridgeState, PopupRequest, RawTool } from "./messages";

/** Presentational state, kept across re-renders. */
let revealSecret = false;

// ---- tiny DOM helpers ----

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: #${id}`);
  return node as T;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(
  className: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const node = el("button", className, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

// ---- service worker plumbing ----

async function request(msg: PopupRequest): Promise<BridgeState> {
  return (await chrome.runtime.sendMessage(msg)) as BridgeState;
}

/** Send a command and re-render from the state it returns. */
async function send(msg: PopupRequest): Promise<void> {
  try {
    render(await request(msg));
  } catch (e) {
    showError(e);
  }
}

function showError(e: unknown): void {
  const node = byId("error");
  node.textContent = e instanceof Error ? e.message : String(e);
  node.hidden = false;
}

// ---- clipboard ----

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for contexts where the async clipboard API is unavailable.
    const area = el("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

function copyButton(getText: () => string, label = "Copy"): HTMLButtonElement {
  const node = button("btn btn-ghost", label, () => {
    void copyText(getText()).then((ok) => {
      node.textContent = ok ? "Copied" : "Failed";
      node.classList.toggle("is-copied", ok);
      setTimeout(() => {
        node.textContent = label;
        node.classList.remove("is-copied");
      }, 1200);
    });
  });
  return node;
}

// ---- formatting ----

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** The MCP URL embeds the pairing token, so only its shape is shown. */
function maskUrl(url: string): string {
  try {
    return `${new URL(url).origin}/t/…/mcp`;
  } catch {
    return url;
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ---- shared widgets ----

function relayForm(state: BridgeState, submitLabel: string): HTMLFormElement {
  const form = el("form", "relay-form");
  const input = el("input", "input");
  input.type = "url";
  input.required = true;
  input.spellcheck = false;
  input.placeholder = "https://my-relay.workers.dev";
  input.value = state.relayUrl ?? "";
  input.setAttribute("aria-label", "Relay base URL");
  const submit = el("button", "btn btn-primary", submitLabel);
  submit.type = "submit";
  form.append(input, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void send({ type: "set-relay-url", url: input.value });
  });
  return form;
}

function snippet(label: string, full: string, shown: string): HTMLElement {
  const wrap = el("div", "snippet");
  const head = el("div", "row");
  head.append(
    el("span", "label", label),
    copyButton(() => full),
  );
  const code = el("pre", "code-block");
  code.textContent = shown;
  wrap.append(head, code);
  return wrap;
}

// ---- sections ----

function renderHeader(state: BridgeState): void {
  const status =
    state.relayUrl === null ? "setup" : state.wsConnected ? "on" : "idle";
  const label =
    status === "setup" ? "Not set up" : status === "on" ? "Connected" : "Idle";
  const conn = byId("conn");
  conn.setAttribute("data-status", status);
  conn.title =
    status === "on"
      ? "Connected to your relay"
      : status === "idle"
        ? "No tab is connected, so the relay socket is closed"
        : "Set a relay URL to get started";
  byId("conn-text").textContent = label;
}

function renderSetup(state: BridgeState): void {
  const root = byId("setup");
  root.replaceChildren();
  root.hidden = state.relayUrl !== null;
  if (!root.hidden) {
    root.append(
      el("h2", "card-title", "Set up your relay"),
      el(
        "p",
        "note",
        "WebMCP Cloud Relay reaches your agent through a relay you host yourself on " +
          "Cloudflare Workers. Paste the base URL of your deployed relay.",
      ),
      relayForm(state, "Save"),
    );
  }
}

function toolList(tools: RawTool[]): HTMLElement {
  const list = el("ul", "tools");
  for (const tool of tools) {
    const item = el("li", "tool");
    item.append(el("span", "tool-name", tool.name));
    if (tool.description)
      item.append(el("span", "tool-desc", tool.description));
    list.append(item);
  }
  return list;
}

function autoConnectRow(origin: string, enabled: boolean): HTMLElement {
  const label = el("label", "check");
  const box = el("input");
  box.type = "checkbox";
  box.checked = enabled;
  box.addEventListener("change", () => {
    void (async () => {
      if (box.checked) {
        // Auto-connect needs a persistent per-site injection, which needs the
        // per-site host permission; Chrome shows its own consent prompt.
        const granted = await chrome.permissions
          .request({ origins: [`${origin}/*`] })
          .catch(() => false);
        if (!granted) {
          box.checked = false;
          return;
        }
      }
      await send({ type: "set-auto-connect", origin, enabled: box.checked });
    })();
  });
  label.append(box, el("span", undefined, "Auto-connect on this site"));
  return label;
}

function renderTab(state: BridgeState): void {
  const root = byId("tab");
  root.replaceChildren();
  const tab = state.tab;

  if (!tab || tab.origin === null) {
    root.classList.remove("is-connected");
    root.append(
      el("h2", "card-title", "This page"),
      el("p", "note", "This page can't provide WebMCP tools."),
    );
    return;
  }

  const origin = tab.origin;
  root.classList.toggle("is-connected", tab.granted);

  const head = el("div", "row");
  head.append(el("span", "host", hostOf(origin)));
  head.append(
    tab.granted
      ? el("span", "pill pill-ok", "Connected")
      : tab.tools.length > 0
        ? el("span", "pill pill-info", plural(tab.tools.length, "tool"))
        : el("span", "pill", "No tools"),
  );
  root.append(head);

  if (tab.tools.length === 0) {
    root.append(el("p", "note", "No WebMCP tools detected on this page."));
    root.append(autoConnectRow(origin, tab.autoConnect));
    return;
  }

  if (tab.granted) {
    root.append(
      el(
        "p",
        "note note-ok",
        state.wsConnected
          ? "Your agent can call these tools right now."
          : state.relayUrl === null
            ? "Set a relay URL to reach your agent."
            : "Waiting for the relay connection…",
      ),
    );
  }

  root.append(toolList(tab.tools));
  root.append(
    tab.granted
      ? button(
          "btn btn-wide",
          "Disconnect",
          () => void send({ type: "revoke", tabId: tab.tabId }),
        )
      : button(
          "btn btn-primary btn-wide",
          "Connect this tab",
          () => void send({ type: "grant", tabId: tab.tabId }),
        ),
  );
  root.append(autoConnectRow(origin, tab.autoConnect));
}

function renderAgent(state: BridgeState): void {
  const root = byId("agent");
  root.replaceChildren();
  root.hidden = state.mcpUrl === null;
  if (state.mcpUrl === null) return;

  const mcpUrl = state.mcpUrl;
  const shown = revealSecret ? mcpUrl : maskUrl(mcpUrl);

  const head = el("div", "row");
  head.append(el("h2", "card-title", "Connect your agent"));
  const reveal = button(
    "btn btn-ghost",
    revealSecret ? "Hide" : "Reveal",
    () => {
      revealSecret = !revealSecret;
      renderAgent(state);
    },
  );
  reveal.title =
    "This URL contains your pairing token — treat it as a password";
  head.append(reveal);
  root.append(head);

  const field = el("div", "field");
  field.append(
    el("code", "code-inline", shown),
    copyButton(() => mcpUrl),
  );
  root.append(field);

  root.append(
    snippet(
      "Claude Code",
      `claude mcp add --transport http webmcp ${mcpUrl}`,
      `claude mcp add --transport http webmcp ${shown}`,
    ),
  );
  root.append(
    snippet(
      "Codex (config.toml)",
      `[mcp_servers.webmcp]\nurl = "${mcpUrl}"`,
      `[mcp_servers.webmcp]\nurl = "${shown}"`,
    ),
  );

  root.append(
    el(
      "p",
      "note",
      state.exposedTools.length > 0
        ? `${plural(state.exposedTools.length, "tool")} currently exposed to agents.`
        : "No tools exposed yet — connect a tab above.",
    ),
  );
}

function renderSettings(state: BridgeState): void {
  const body = byId("settings-body");
  body.replaceChildren();
  // Before setup the relay URL already has a card of its own, and there is
  // nothing else worth showing.
  byId("settings").hidden = state.relayUrl === null;
  if (state.relayUrl === null) return;

  body.append(el("span", "label", "Relay base URL"));
  body.append(relayForm(state, "Save"));

  const danger = el("div", "danger");
  danger.append(
    el("span", "label label-danger", "Danger zone"),
    el(
      "p",
      "note",
      "Regenerating the pairing token invalidates the current MCP URL. Every agent has " +
        "to be registered again with the new one.",
    ),
    button("btn btn-danger", "Regenerate token", () => {
      const ok = confirm(
        "Regenerate the pairing token?\n\n" +
          "The current MCP URL stops working immediately and every agent must be " +
          "re-registered with the new URL.",
      );
      if (!ok) return;
      revealSecret = false;
      void send({ type: "regenerate-token" });
    }),
  );
  body.append(danger);
}

// ---- entry point ----

function render(state: BridgeState): void {
  byId("error").hidden = true;
  renderHeader(state);
  renderSetup(state);
  renderTab(state);
  renderAgent(state);
  renderSettings(state);
}

async function main(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    render(await request({ type: "get-state", tabId: tab?.id ?? -1 }));
  } catch (e) {
    showError(e);
  }
}

void main();
