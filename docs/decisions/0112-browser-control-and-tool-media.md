# 0112: Browser control and host tool media

Status: Accepted

## Context

The user wants reliable browser control and pointing across harnesses, including
Codex. Host tools currently stringify all results, losing images. Browser actions
simulate DOM events, which cannot reproduce native editing or keyboard behavior.

## Decision

Keep one host tool contract, with an explicit multimodal result for text and
images. Claude's provider and runtime, Codex's authenticated workspace MCP, and
the built-in AI SDK adapter preserve those blocks in model input. Plain tool
return values keep their ordinary JSON/text semantics. Validate MCP arguments at
the same schema boundary used by the other adapters.

The desktop owns browser mechanics. A dedicated driver uses isolated-world DOM
inspection, document-scoped element references, Chromium input, and bounded
screenshots. Extend the existing snapshot, action, and pointing tools instead of
adding a competing computer-use tool family. User takeover gates every input.
Page content remains untrusted data. Browser access does not imply OS control.

Codex uses its native MCP support. Codex desktop's separate computer-use plugin
is not assumed to be part of the CLI or SDK. Verify the pinned executable's media
transport with a loopback model fixture, alongside real Electron browser tests.

## Consequences

Harness adapters translate content, not browser behavior. Embedders can supply
their own media-producing tools without an Electron dependency. Alpha element
references become opaque strings; agents must refresh snapshots after changes.

Codex runs through its bidirectional `app-server` transport. The host supplies
elicitation and native approval handlers; missing handlers decline. Each session
retains its MCP children between turns and releases them after five idle minutes,
on changed connection configuration, or disposal. Resume uses the durable thread
ID. Cancellation prevents late approval from executing tools.

The desktop can opt into its user's installed Codex Computer Use runtime as a
profile connector, referenced in place. OS and per-app permissions still belong
to the native service. The connector exposes native computer surfaces; Catamorphic
browser tools own embedded tabs. Removing the connector never removes Codex's
installation. Libraries have no dependency on that app or its filesystem layout.
