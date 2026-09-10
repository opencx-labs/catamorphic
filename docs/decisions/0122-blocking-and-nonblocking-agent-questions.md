# 0122: Blocking and non-blocking agent questions

- **Status:** Accepted
- **Date:** 2026-09-10
- **Refines:** 0067, 0074, 0112

## Context

Agents need to ask preferences while continuing independent work. Later answers
must reach the running agent as soon as its harness accepts input, rather than
waiting in the chat queue until the whole turn finishes.

## Decision

Give each question batch a `blocking` boolean, defaulting to `true`. Reuse the
durable runtime request store for request identity, questions, state and responses.
A non-blocking tool returns an acknowledgement immediately. Questions remain
answerable across continued work, completed turns and renderer reloads. Answers
identify the request; ordinary composer messages do not implicitly resolve it.

The host supplies question and pending-input callbacks through turn options.
All answers are resolved atomically into the existing durable session inbox.
Blocking tools await their persisted response and acknowledge their own delivery;
non-blocking answers are eligible for steering, independently of which server
receives the answer. The current executor reads
eligible input and acknowledges consumption under its execution lease. Unconsumed
answers start a continuation when the turn ends. Duplicate submissions are
idempotent; a conflicting answer cannot overwrite a resolved request.

All three interactive harnesses use the same question schema and host callbacks.
The built-in AI SDK loop inserts answers in `prepareStep` before the next model
call and retains that prepared history. Codex reuses its existing persistent
app-server connection, exposing a dynamic question tool and sending answers with
`turn/steer` guarded by the expected turn id. Claude Code uses a host MCP question
tool and streaming input with `priority: now`. Its intermediate native results
remain inside one host turn; the final result provides cumulative usage, and input
UUIDs on results acknowledge consumed answers. Its native AskUserQuestion remains
a blocking question. Standalone runtime request/response behavior is unchanged.

The desktop, PWA and reusable panel label non-blocking questions "Answer when
ready". Collapsing preserves the request and draft. Blocking questions display
"Waiting for your answer". Permission requests remain blocking.

## Consequences

The built-in loop takes input between model calls. Codex steers its active turn;
Claude Code may interrupt an in-flight model request to process immediate input.
Neither requires the user to stop work manually or create another chat turn.
Native protocol tests run the pinned executables against loopback model fixtures,
without real provider credentials. Core tests cover durable delivery and races;
desktop E2E verifies the actual question panel and continued work.
