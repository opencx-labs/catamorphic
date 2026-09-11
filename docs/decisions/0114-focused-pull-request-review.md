# 0114: Focused pull request review

Status: Accepted; generated Markdown guides superseded by [0124](0124-session-artifacts.md); external-only replies superseded by [0115](0115-native-review-conversation.md)

## Context
Expandable PR files in the workspace sidebar duplicated review navigation.
Stacked search fields and toolbars crowded out code. Author descriptions lacked
GitHub HTML rendering, and review metadata was missing.

## Decision
A PR row opens its review directly. Overview, Guide, Changes and Discussion have
distinct purposes. Changes has one optional search with filename/content scope,
an optional file navigator, and a display menu. The host can hide DiffView's
toolbar and supply its search query; the primitive remains independent of desktop.

Overview displays CLI-backed reviewers, assignees, decisions and check links.
Discussion combines conversation comments, review bodies and paginated inline
comments. Inline replies retain their parent thread; missing parents remain visible.
Outdated comments never reuse an original line as a current line. Inline-comment
failures are explicit. Replies open on GitHub; the
desktop does not submit comments or reviews in this change.

GitHub descriptions use remark-gfm, rehype-raw and rehype-sanitize, in that order,
to preserve tables and disclosures while removing executable markup.

## Consequences
The workspace sidebar stays compact. GitHub credentials never enter the renderer.
Metadata is refreshed independently, so unavailable checks do not block diffs.
Linear's information hierarchy informed the design; Catamorphic's components,
tokens, shortcuts and local review progress remain its own.

Guide generation is an explicit action using the existing headless agent hook
and the permitted agent catalog. Its editable Markdown links resolve only to
files in the current PR. Completed output is retained locally per PR, with the
patch revision recorded so changed evidence makes the guide stale. Each file
gets a bounded evidence allowance; omitted text is flagged to the agent. The
change map remains available without generation. Native replies are not implemented. File
navigation uses a virtual tree that fills its available viewport; long comment
bodies can be expanded without leaving the review.
