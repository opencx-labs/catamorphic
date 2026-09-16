# Local agent and live sidebar audit

Verified on macOS on 2026-09-17 in a dedicated development worktree and profile.
The installed application and its user projects were not modified.

## Real Codex session

A local-auth Codex agent was created with no mode or model override. Its public
mode resolved to `full-access`. The installed Codex computer-use connector was
assigned through the desktop's normal connector integration. These were real
provider calls through Catamorphic's embedded server, not the E2E fake agent.
Session: `6a35632c-0242-47b7-a610-2b5a1626702b` in the development profile.

| Task | Observed result |
| --- | --- |
| Create TypeScript code and run Bun tests | 3 tests passed, covering negatives, zero and fractions |
| Everyday notes and todo data | Created Markdown and JSON files; verified readback |
| Edit the actual profile theme with terminal tools | Wrote `theme.json` outside the project; live window changed to dark green |
| File access outside the checkout | Wrote and read a marker in the development data directory |
| Run a local service | Started a Bun HTTP server, fetched HTTP 200, stopped it, verified connection refusal |
| Native computer use | Read the development app's accessibility state and retrieved its screenshot |
| Image and PDF attachments | Read the supplied screenshot and extracted the PDF sentence using native input/file tools |
| Continue the same conversation | The existing computer-use JavaScript binding survived into the next turn; appended and verified a note |

The desktop had still advertised Codex as text-only even though native attachment
staging already existed. The composer capability declaration now matches that
staging path, with an Electron test verifying an attached image retains its media
bytes.

No Catamorphic approval, authentication, working-directory or media blocker
occurred. The initial broad skill discovery query returned no matches; a narrower
query succeeded. `Catamorphic Dev` is not the development app's OS name, and
`com.github.Electron` was ambiguous among worktrees. Selecting the exact running
Electron application path succeeded. These are discovery wrinkles, not permission
denials; the session reported and recovered from them.

Codex-managed restrictions, model availability, installed connector availability
and macOS permissions still apply. Native Codex subagents and goals remain replaced
by Catamorphic's session/delegation and goal capabilities, as in ADR 0133. Remote
execution and explicitly restricted local agents retain their configured limits.

## Sidebar scenarios

A real file-backed todo module and a localhost HTTP-backed module were mounted
through `source.module`, using ordinary Bun IO. The isolated Linux Electron suite
exercises initial loading, successful writes and busy indicators, external atomic
file replacement, retained HTTP rows during refresh, HTTP failure and retry,
hidden-source cleanup, reduced motion and a virtualized 500-item list. Runtime tests
cover pagination, cancellation, simultaneous serialized actions, source reload,
crashes, hung workers, and idle process retirement.

Manual computer-use checks in the macOS development app exercise completing a
todo, a failed write, HTTP failure/retry and switching sidebar tabs, initial loading skeletons and source recovery. Sources use the
existing native item rows, menus, tree virtualization and enter/exit motion.
