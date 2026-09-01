# Privacy Policy — WebMCP Cloud Relay

_Last updated: 2026-09-01_

WebMCP Cloud Relay is a Chrome extension that bridges WebMCP tools from browser
tabs you explicitly connect to MCP clients (such as Claude Code), through a
relay server. This policy describes what data the extension and the relay
handle.

## What data is handled

The extension touches page data **only on tabs you explicitly connect** via the
popup. Nothing is read from, or injected into, any other page.

For a connected tab, the following passes through the relay you have
configured (the hosted instance at `relay.webmcp-cloud-relay.workers.dev` by
default, or your own):

- **Tool definitions** the page registered via WebMCP: tool names,
  descriptions, and input schemas.
- **Tool traffic**: the arguments your MCP client sends to a tool, and the
  result the page returns. Depending on the page, this can include page
  content (for example, the text of a note a tool creates or lists).

Transport is encrypted (TLS), but tool traffic is readable inside the relay
while a call is in flight. If you do not want the hosted relay's operator in
that position, self-host the relay — the extension accepts any base URL, and
the relay is this repository's open-source code.

## What is stored

- **In your browser**: the pairing token and relay URL
  (`chrome.storage.local`), and the list of currently connected tabs
  (`chrome.storage.session`, cleared when the browser closes).
- **On the relay**: only the current tool-definition snapshot per pairing
  token, kept so MCP clients can list tools; it is deleted after 24 hours
  without a connected extension. The relay is addressed by the SHA-256 hash of
  the pairing token; the token itself is never persisted. Tool arguments and
  results are relayed in memory and not stored.

The extension and relay have no user accounts and collect no personal
information: no browsing history, no analytics, no identifiers beyond the
randomly generated pairing token.

## What is not done

- No data is sold, shared with, or disclosed to third parties.
- No data is used for advertising, profiling, or creditworthiness purposes.
- No data is transferred anywhere other than the relay you configured.

## Permissions

- `activeTab` + `scripting`: inject the WebMCP reader into a tab, only when
  you open the popup on it. The extension has no host permissions.
- `storage`: keep the pairing token, relay URL, and connected-tab list.

## Changes and contact

Changes to this policy are published in this repository's history. Questions:
open an issue at <https://github.com/mtsmfm/webmcp-cloud-relay/issues>.
