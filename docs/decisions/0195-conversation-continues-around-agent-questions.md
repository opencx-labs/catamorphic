# 0195: The conversation continues around agent questions

- **Status:** Accepted (amended by [0197](0197-agent-sessions-are-an-event-log-of-turns.md): replies to a waiting question steer the turn)
- **Date:** 2026-10-02
- **Refines:** 0122

## Context

A blocking `ask_user` call held the turn until its panel was answered. A chat
message sent meanwhile waited in the queue behind the question, so the person
could not ask "what is the difference?" before choosing. The panel's "Other"
row was a second, smaller composer that could not take pastes, attachments or
pills. Answers rendered in history as the text the agent receives, and an agent
had no way to withdraw a question the conversation had already settled.

## Decision

A message a person sends while a blocking question waits returns the waiting
call. An agent's question becomes non-blocking and stays open beside the chat;
the call rejects with `QuestionReplyError`, whose text tells the agent the
message follows and the answer arrives later. The message is steered into the
same turn through `readPendingMessages`, with its attachments rendered as the
harness renders a turn's own. A consent request (`consent: true`, permission and
app access) is withdrawn instead and reads as declined. Answers still never
come from ordinary messages: only the panel resolves a request (0122).

When the harness first takes steered input, the in-progress assistant message
moves after it in the transcript, so a reply reads below the message it answers.

Agents get `close_questions`, beside `ask_user` in all three harnesses, to
withdraw their own open questions; it never closes consent. Panels drop the
"Other" row: the composer is the free-text channel, and its placeholder says so
while a question is open. The waiting status sits in the panel header. Answer
messages carry the question batch and raw answer in metadata, and timelines
render them as questions with what was picked.

Considered: resolving the call with the message as the answer (Claude Code's
parked behavior). It loses the panel the person wanted to come back to, and
makes the agent ask again. Interrupting the turn kept attachments but showed the
person an interruption they did not ask for.

## Consequences

Every harness must handle `QuestionReplyError` where it calls `askQuestion`:
`askUserToolResult` turns it into the tool's text, Claude Code's native
AskUserQuestion denies with it, and consent callers treat it as a decline.
Non-blocking questions now also come from conversations, so agents are told to
close what a reply settled. Hosts without a composer beside the panel should
keep a way to answer open-ended questions.
