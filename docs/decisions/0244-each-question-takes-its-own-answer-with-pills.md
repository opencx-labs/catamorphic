# 0244: Each question takes its own answer, pills and all

- **Status:** Accepted
- **Date:** 2026-10-18
- **Amends:** 0195

## Context

ADR 0195 dropped the question panel's Other row: it was a smaller composer
that could not take pastes or pills, and the chat composer could carry free
text instead. One reply cannot answer each of several questions, though, and
an answer is text to every harness: Claude Code and Codex take only strings,
so a pill or an image had nowhere to ride.

## Decision

Every question has an Other answer again, and a host may give it its
composer's own input. An Other answer carries its pills the way a message
does: `RuntimeRequestResponse` of kind `question` keeps `answers: string[]`,
in which an answer may hold attachment markers (U+FFFC), and gains
`attachments?: AgentAttachment[][]`, each answer's pills in the order of its
markers (a stray marker goes; a pill without one gets one at the end). The
request stores the answers as they were written, so history draws each answer
with its pills in place. A message that carries an answer (`QuestionAnswer`)
keeps only the words: its card takes the pills from the request, so a large
file is never stored twice for one answer.

Core turns a blocking answer into what the asking agent reads before the
runner sees it: each answer becomes text, its text pills rendered in as a
message renders them (`renderQuestionAnswer`). Images and documents cannot
ride in a text answer, so they follow at once as a steered message from the
person ("With my answer to …") that carries the same `QuestionAnswer`; the
answer names each one where it sat by its number in that message. The turn
takes the message at its next step; should it end first, the message runs as
the next turn, and until then history shows the request's own card. A
non-blocking answer already reaches the agent as a message, which now carries
every pill as its attachments.

Alternatives: spelling pills out in the answer's text works with no format
change, but history then shows a long paste in full instead of a pill.
Carrying media in the answer itself needs every harness to accept it, and
Claude Code and Codex would still need the message underneath.

## Consequences

Answers and messages share one pill model, markers and all; the timeline
draws an answer's pills with the message renderer. A response may carry at
most 50 attachments in all; the desktop budgets each answer box as it budgets
a message, so several full boxes can exceed that and are refused whole. Hosts that give the panel a plain text box send
answers without attachments, as before. The message that carries an answer's
media shows as that answer's card, so history keeps one card per answer.
