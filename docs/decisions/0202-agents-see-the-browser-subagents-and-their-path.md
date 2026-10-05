# 0202 — Agents see the browser, their subagents and their PATH

- **Status:** Accepted
- **Date:** 2026-10-05
- **Amends:** 0133 (eager surface), 0090 (delegated results), 0112 (browser control), 0093 (desktop PATH)

## Context

A Claude Code agent in the desktop audited its own limits against earlier chats.
Its PATH was launchd's (`/usr/bin:/bin:/usr/sbin:/sbin` plus Bun), so `gh`,
`gcloud`, `node` and every `npx` MCP server failed in a Dock-launched app. The
browser tools sat behind `discover_capabilities`: a query for "browser terminal"
matched only the two capabilities mentioning both words, and one chat told the
person Work's browser could not click. `invoke_capability` failed four chats on
`requestId` and on fields placed beside `input`. The delegation prompt said
"call spawn_subsession", a tool it could not see, with Claude Code's own Agent
tool removed; the agent concluded it could not delegate. Claude Code's tool
search deferred even the eager tools. Chats read "Chat 1" until their first turn
settled, since neither Claude Code (in SDK mode) nor Codex's app-server names one.

## Decision

- **Browser and subsessions are eager.** `open_browser`, `browser_snapshot`,
  `browser_act`, `spawn_subsession` and `wait_for_subsessions` join the direct
  surface; the eager schema budget rises from 8.3 KB to 13.5 KB. The playbook
  names them and calls subsessions the agent's subagents.
- **Claude Code loads every host tool.** Host tools carry
  `_meta["anthropic/alwaysLoad"]`; the host already chose which tools a turn
  sees, so the harness's own tool search must not hide them.
- **A subsession's result steers into its parent's working turn**, and becomes a
  new turn only when the parent is idle, like a background subagent's; a harness
  that refuses the steer keeps working and gets the result as its next turn. Only
  an agent its host gives `spawn_subsession` is told about subagents. Waiting
  with no ids waits on the children running now. The result names its subagent.
- **Discovery ranks** by matched words (a name match counts double) instead of
  requiring every word. `requestId` is optional; invalid input names the
  capability, where its fields go, and its schema.
- **The browser does what a person does**: `upload` answers the page's own file
  chooser over CDP, `downloads` reports this tab's saved files, `evaluate` runs
  JavaScript in the page, and `console` and `network` read what the page logged
  (from its load) and requested (from when an agent first drove it). A uid stays
  valid while its element stays in the page; a covered element names its cover.
  Outside the agent's own folder, hidden files and folders and `~/Library` are
  never uploaded, so page text cannot talk an agent into sending keys or tokens.
- **The desktop adopts the login shell's PATH** at startup, before the server
  boots: login entries first in a packaged app, appended in one started from a
  terminal. Only PATH is taken, never the shell's other variables.
- **An untitled chat takes its first message that starts work as its name** when it is sent; a
  harness title (the built-in agent's `set_title`) still replaces it.

Rejected: mounting every capability as a direct tool (schema cost for harnesses
without tool search); delivering results only through `wait_for_subsessions`
(a parent that never waits would never hear); a Work-side title model call (the
person asked for harness titles, which Claude Code does not expose in SDK mode).

## Consequences

Agents find the browser and delegation without searching, and local harnesses
reach the person's tools. Every turn carries about 13 KB of host schemas. Evaluate
and network capture bypass the snapshot's password redaction, as screenshots
already do; pages stay untrusted data. Results arriving mid-turn depend on the
harness accepting steers (all three do). Server hosts still offer no delegation
tool to agents, so their agents keep their harness's own subagents and hear
nothing of subsessions.
