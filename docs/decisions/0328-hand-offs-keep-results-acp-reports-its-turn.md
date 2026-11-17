# 0328: Hand-offs keep results and open requests; ACP agents take effort and report their turn

- **Status:** Accepted (amends 0198, 0241, 0255, 0298)
- **Date:** 2026-11-17

## Context

A pull request review chat lives across many pushes and comments. Its
OpenCode coordinator runs as an ACP agent in the chat's sandbox on a server
(ADR 0255), and Work does not hold an ACP agent's thread: when the sandbox
is replaced (idle release, a lost machine), the next turn starts a new
thread handed a budgeted summary of the conversation (ADR 0198, 0245). The
summary trims from the middle, so a long chat can lose exactly what the
agent most needs: the results it already submitted (ADR 0323) and the
requests it has not answered. The opencx watcher kept OpenCode's SQLite on
an encrypted volume per pull request for this, and its big runs still
failed once compaction dropped the original observations. The ACP adapter
also ignored effort, reported no usage, and never said when the agent's
model calls were being refused, so a retrying agent looked busy.

## Decision

**A hand-off keeps what must not be summarized.** When a provider thread is
handed the conversation, on any harness, the hand-off carries two labeled
sections verbatim, outside the summary's trimming:

- *Your accepted results*: the latest result of each name (newest first),
  with its turn, the input it answers (quoted briefly), and whether a newer
  input arrived since. A value above 8 KiB is cut to an excerpt that names
  the result id to read whole with `session_results`.
- *Requests you have not answered with a result*: the inputs of the
  covered turns after the newest result's input, newest kept when cut. A
  chat with no result carries its latest three inputs instead.

Both share half of the hand-off budget (32,000 of 64,000 characters), the
summary takes what they leave, and each says how many it left out and
where to read them. The current turn's own input is the prompt, so it is
never repeated.

**ACP effort.** The adapter applies the attempt's effort (definition
default, session override, delegation) through the agent's `thought_level`
option (`session/set_config_option`), after the model, since an agent's
effort levels follow its model (OpenCode offers its model variants as an
"effort" option). A value or name equal to the level is set. An agent that
offers no such option, not that level, or refuses it, gets the turn as is,
and the turn says so in a `setting_not_applied` notice, as an unknown or
refused model now does too. Harnesses may now report `notice` items for
this.

**ACP usage and provider retries.** The prompt answer's `usage` (unstable
in ACP; OpenCode sends it) becomes the turn's usage: input, output,
reasoning and cache tokens; `usage_update` adds the context size and
window, and the session cost the agent reports in USD minus what it
reported before the turn. ACP has no retry notice, and OpenCode keeps its
retry status to itself, so retries are observed where Work stands: the
loopback model endpoint (ADR 0255) sees each refused model answer (408,
425, 429, 5xx, 529). A refused answer is `provider.retrying` with the
provider's message, no counts, and a deadline only from `Retry-After`; new
agent output afterwards is `provider.resumed` (ADR 0298). An agent on its
own sign-in reports no retries.

**Continuity across sandbox replacement stays the hand-off.** Evaluated
and not built: ACP's `session/load` reopens a session the agent stored and
takes no history from the client, so Work-held history cannot restore one.
Persisting the agent's data directory as provider thread entries is not
generic or bounded: OpenCode keeps every session of the machine in one
SQLite file (with its write-ahead log) beside its sign-ins, unbounded in
size; other agents store elsewhere. OpenCode's own `export`/`import`
commands would work for it alone; a definition field naming such commands
is a follow-up if a second agent offers the same.

**No warm ACP process yet.** A sandbox runner owns one attempt and exits
with it (ADR 0222), so a warm process helps only the desktop, while each
attempt gives the agent a new loopback tool server and bearer bound into
its session at `session/new`. Keeping it warm needs a server that outlives
attempts and routes to the current one; it stays a follow-up.

Considered: keeping results inside the summary (trimmed like any line);
ignoring an unknown effort silently; inferring retries from silence or
text, which ADR 0298 forbids.

## Consequences

A chat that loses its ACP thread, or switches harness, continues with its
accepted results and unanswered requests in front of the agent, at no more
than half the hand-off's budget. Effort set for an OpenCode reviewer reaches
it, and a level it cannot take is visible in the chat. Usage and cost for
ACP turns appear in turn state. Retries appear only for agents on a model
connection; a refused call made by a child process the agent started marks
the turn too, since they share the endpoint.
