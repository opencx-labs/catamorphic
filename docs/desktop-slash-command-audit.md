# Desktop slash command audit

Audited 2026-09-11; full local validation passed against main at `7a0b2058`.
Rebased onto `56678c7a` before publishing, preserving the browser-import and
review-theme changes. Final pushed-head validation is tracked by CI.

## Supported paths

| Harness | Shared skills | Native menu entries | Invocation |
| --- | --- | --- | --- |
| Built-in AI SDK | Project, personal, and app skills | None | Existing harness-neutral skill message |
| Claude Code | Same shared skills | Pinned CLI's `supportedCommands`, including `/compact`, project commands and installed plugin skills | Literal native command with arguments, or the shared skill message |
| Codex | Same shared skills | Pinned app-server's `skills/list`, with disabled entries excluded | Skill message naming its discovered file |
| ACP | Not an executing harness in this repository | None | Existing unavailable-agent explanation |

Codex CLI UI actions are not app-server chat commands. This change does not
advertise `/compact`, `/clear`, or other terminal UI actions for Codex by
sending their names to a model. Adding those actions requires their real
protocol operations and session lifecycle semantics.

## Findings and repairs

- **Whitespace destroyed command completion.** The contenteditable reported
  trimmed prose to the parent, so Tab's trailing space and typed spaces did
  not reliably close the picker. Live composer state now preserves whitespace;
  outgoing messages retain their existing trimming.
- **Typed and picked commands disagreed.** One resolver now handles shared
  skills, native skill paths, literal native commands, and arguments. Attachment
  markers remain positional, including a pill immediately after a skill name.
- **Local status could discard context.** `/status` is reserved consistently,
  opens the session inspector locally, and preserves attached pills. Neither
  normal Send nor Send now sends it to a model.
- **Catalogs omitted executing configuration.** Discovery now shares the project
  agent's definition and consent resolution with execution. Claude discovery
  uses the executing settings sources and assigned plugin paths. Discovery uses
  the session's checkout, and configuration or checkout changes invalidate the
  visible catalog. Late responses cannot cross agent, session, or project keys.
- **Stale data and silent failures.** Removed the five-minute command cache.
  Each slash entry refreshes files. Discovery exposes loading, errors, empty
  results, and Retry. Failed unresolved command submission retains the draft.
  CI also exposed previous rows briefly reappearing when reopening the palette.
  Shared and native results now belong to the exact refresh request during
  render, preventing stale rows before effects run. A regression fails against
  the previous implementation and passes with the fix; another covers late
  responses after changing projects.
- **Native Codex skills were absent.** Read them through the existing app-server
  transport without creating a thread or turn. Resolve them to a skill message
  with the exact file path, consistent with the existing skills-as-messages model.
- **Skill offers ignored selection.** The slash menu and palette use one helper
  to apply the selected agent's shared skill assignment, including an empty set.
  Shared skill names shadow native names; desktop action names win collisions.
- **Navigation was fragile.** Selection is keyed by command identity, search
  includes human titles and descriptions, and an exact command name ranks first.
  The textbox exposes its active option to assistive technology. Modified arrows
  and Shift+Tab retain their normal behavior; IME confirmation cannot send.
- **The overlay was hard to read and clipped.** Fixed-height rows show readable
  titles, concise descriptions and origins. Arguments have a stable footer.
  Native top-layer placement preserves inherited theme tokens and DOM ownership,
  clamps width and position to the viewport, and escapes the chat's clipping.
  Keyboard selection scrolls into view. Closing surfaces are inert during exit.
- **Discovery lifetime was incomplete.** Claude probes race a real deadline and
  close on success, failure, and timeout. Hooks, model prompts, session
  persistence, and MCP connections are disabled for discovery. Codex uses a
  bounded existing transport and closes it in `finally`.

## Interaction contract

The accepted ADR 0052 interaction is retained: Enter or a pointer selection runs
an entry; Tab completes it and leaves a space for arguments; Escape dismisses
suggestions. Shift+Enter still inserts a newline. Send and Send now resolve the
same command syntax. Unknown slash text remains an ordinary message after a
successful catalog load. No new core command runtime or workflow format exists.

The palette remains a shared skill launcher. Native command discovery belongs
to the chat with its selected harness and checkout. There is no equivalent
slash-picker surface in the installable registry to synchronize.

## Verification

- Unit regressions: collisions, title search, skill assignments, native commands,
  native skill paths, whitespace, multiline arguments, attachment positions,
  discovery failures and an SDK that ignores abort.
- Pinned CLI fixtures: Claude project commands and installed plugin skills,
  `/compact` availability, disabled initialization hooks; Codex checkout skills
  and fresh file edits. Model credentials and network endpoints are isolated.
- Real Electron: skill launch, arguments, IME, Escape, empty state, active
  descendant linkage, scrolling, Retry, all three harness catalogs, project
  agent consent and stale consent, harness switching, local status context.
- Visual checks: normal dark composer and compact light composer. The compact
  case caught and drove the top-layer placement fix.

The deterministic fixtures do not claim coverage of live provider outages,
third-party plugin behavior, or model compliance with a skill's instructions.
The repository's full `bun run check` is the completion gate for this change.

Current verification after pulling main:

- Manual real-agent verification ran in the worktree's dedicated desktop profile
  and disposable `slash-real-verification` project. Composer input and pointer
  actions used the running Electron app's CDP driver.
- Built-in (`gpt-5.4-mini`) and Codex loaded `/slash-probe`, read a local file,
  and returned `SLASH_OK probe-847291` with their distinct typed arguments.
- Codex also discovered `.codex/skills/codex-probe/SKILL.md` through the native
  app-server catalog. Tab plus arguments dispatched the exact file path and
  returned `CODEX_NATIVE_OK probe-847291 native-path-label`.
- Claude discovered and invoked `.claude/commands/native-probe.md`, returned
  `NATIVE_OK probe-847291 claude-label`, and completed `/compact` selected by
  pointer. Discovery now suppresses generated app-plugin aliases while retaining
  the shared skill and external plugin entries.
- A real built-in turn exposed recoverable tool failures being emitted as terminal
  errors. It now emits the existing diagnostic event, matching Codex. A second
  real turn deliberately read missing files, recovered, and completed without a
  false Retry banner. The package regression checks recovery and completion;
  the existing terminal model failure test remains in place.
- The skills E2E suite now types through Chromium's real editing path and sends
  native Claude commands, native Codex file-based skills, and shared built-in
  skills with Tab completion and arguments after switching harnesses.
- The isolated 16-test skills E2E suite passed. Its palette-target regression
  now compares chat identities instead of counting all labeled sections, which
  incorrectly included the closing session inspector.
- **The full `bun run check` passed in one run on the merged branch.** This
  includes lint, all typechecks and builds, database synchronization, all 120
  orchestration tests, deterministic workspace tests (including 530 desktop,
  431 core, 70 Claude, 43 Codex, and 41 built-in harness tests), and 8 PWA E2E tests.
- The complete isolated desktop run passed all 38 suites: 289 tests passed and
  one existing macOS-only `open` shell integration case was skipped on Linux.
  The 16 slash-command tests passed both alone and within this full gate.
- Real-agent screenshots are retained under
  `test-results/slash-manual-2026-09-11/`. The full gate log is copied there as
  `full-check.log`. The implementation was prepared on `codex/slash-command-audit`.
- Follow-up verification after publication: 548 desktop unit tests and the 21
  skill/settings-palette E2E cases passed. The complete Electron rerun passed
  all 39 suites: 291 tests passed and the existing macOS-only test was skipped
  on Linux. The broad rerun also exposed a
  terminal-preview assertion reading a different hovered card; it now targets
  the focused member through `aria-details`, with the expected preview verified
  in the failure screenshot. The latest main CI-caching update was pulled before
  publishing the follow-up.

Native protocol references: [Claude SDK skills](https://code.claude.com/docs/en/agent-sdk/slash-commands)
and [Codex app-server skill discovery](https://learn.chatgpt.com/docs/app-server#skills).
The checked-in pinned-CLI tests establish the versions used by this repository.

## T3 Code comparison

Reviewed upstream T3 Code at
[`5eecc24a`](https://github.com/pingdotgg/t3code/tree/5eecc24a10013be14e496b485f8d1d9491c75f6a)
on 2026-09-11. This was a source and regression-test comparison, not a live
provider evaluation of their app.

| Approach | Decision here |
| --- | --- |
| Separate name search from description search | Adopted. Exact names and name prefixes rank first; descriptions match literal text. Fuzzy names and human titles still work. Letters scattered across a description or across separate fields cannot create a command match. |
| Read the editor again when selecting | Adopted using our existing composer reader. Enter, Send, and Tab cannot apply a stale menu row to freshly edited text. Pending unknown slash input still waits for discovery. |
| Prevent focus loss on press; activate on click | Adopted with native buttons. Pressing a row alone does not launch a command, and the composer retains focus. |
| Stable item identity, source labels, scroll active item into view | Already present in the audit implementation. |
| Enter and Tab both insert a command before a separate send | Retained our existing Enter-to-run, Tab-for-arguments contract. Tab already offers composition without a send; changing both paths is a product interaction tradeoff, not a necessary architectural simplification. |
| `$skill` mentions and `/skill:` menu labels | Kept the single `/name` entry point. T3 supports inline skill mentions with additional provider-specific dispatch; our shared skills already have one invocation-message model. Native commands remain native. |
| Per-workspace provider catalogs and invocability filtering | Kept native discovery through the pinned harnesses and our shared agent configuration. We do not duplicate Claude's skill/settings parser. |

T3's [search implementation](https://github.com/pingdotgg/t3code/blob/5eecc24a10013be14e496b485f8d1d9491c75f6a/apps/web/src/components/chat/composerSlashCommandSearch.ts),
[selection path](https://github.com/pingdotgg/t3code/blob/5eecc24a10013be14e496b485f8d1d9491c75f6a/apps/web/src/components/chat/ChatComposer.tsx),
and [menu component](https://github.com/pingdotgg/t3code/blob/5eecc24a10013be14e496b485f8d1d9491c75f6a/apps/web/src/components/chat/ComposerCommandMenu.tsx)
informed these refinements. Their
[invocation regression report](https://github.com/pingdotgg/t3code/issues/7671)
and [Claude dispatch implementation](https://github.com/pingdotgg/t3code/blob/5eecc24a10013be14e496b485f8d1d9491c75f6a/apps/server/src/provider/Drivers/ClaudeSkillDispatch.ts)
reinforce keeping native slash commands at the beginning of a message and
distinguishing an actual native invocation from a skill named in prose.

Added regressions cover name/description ranking, cross-field false matches,
press without activation, and input plus Enter/Tab/Send arriving before the
menu rerenders. No new dependency, command runtime, or invocation syntax was added.
