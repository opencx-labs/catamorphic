# 0123: Desktop consent, search and resource links

- **Status:** Accepted
- **Date:** 2026-09-10
- **Supersedes:** Sidebar search and editable-file theme behavior in 0118

## Context

Testing the alpha exposed duplicate file pickers, an unwanted default project
note, consent dialogs detached from their chats, code links presented as
workflows, and an editor palette disconnected from the surrounding app.

## Decision

Use the existing command palette for file discovery and sidebar item searches.
Searchable section headers have one search button opening a named scope over
their items. Remove sidebar text inputs and the editor's separate file picker.
The agent action reads "Ask agent" with the default agent name as secondary text;
it never repeats the draft prompt. Remove the project note from sidebar defaults.

Session tool consent and native app-access consent use the existing durable
blocking question mechanism. The owning chat shows its waiting state, survives
navigation and renderer reload, and accepts answers through the same API as
ordinary questions. Only explicit allow choices grant access. Cancellation
withdraws unresolved blocking requests. Sessionless host prompts retain the host
bridge; connector forms and sign-in flows keep their typed elicitation contract.
Host-owned, session-scoped MCP endpoints enforce their own capability and identity
checks and do not acquire a second native approval layer. External connections
retain their policies and genuine consent requests.

Use existing Markdown destinations as the resource reference standard:
`workflow:<exportName>` opens a graph, `app:<appName>` opens an app, and
`file:<path>` opens the file's appropriate surface. Agents present workflow and
app deliverables with semantic links, including drafts. Explicit source links
remain available. Resource pills identify their kind and share opening modifiers.

Editable files keep Monaco and bundled Shiki grammars. Derive surfaces, syntax,
selection, cursor, diagnostics and widgets from the resolved app theme; the
selected code preset supplies remaining grammar styles. Changes apply live.

## Consequences

Search, navigation and consent reuse existing primitives. There is no additional
workflow representation or approval store. Regressions must cross the navigation,
renderer-reload, answer-delivery and cancellation boundaries, with visible native
verification of the editor and question panel.
