# Real agent customization evaluations

These opt-in evaluations run Work's actual Codex, Claude Code, or builtin
adapter through its shared runner protocol. They do not run during deterministic
tests and do not require Verdaccio, a setup wizard, or Electron.

Build the workspace packages first. List scenarios without credentials:

```sh
bun run eval:customization --list
```

Run an actual signed-in Codex agent:

```sh
bun run eval:customization --live --harness codex --scenario todo-sidebar
bun run eval:customization --live --harness codex --scenario private-reminder
```

The harness chooses its own default model unless `--model` is supplied. The
report records the actual model and usage. `--effort` accepts low, medium, high,
xhigh, or max. Repeated attempts get independent projects and profiles:

```sh
bun run eval:customization --live --harness codex --model <model-id> \
  --effort high --scenario todo-sidebar --runs 3 --timeout 600 \
  --output test-results/customization-evals/comparison
```

`--timeout` is the agent budget in seconds, between 1 and 3600. Compiler,
source-worker, workflow-worker, and shutdown operations also have bounded
timeouts. A failed attempt exits nonzero and retains its evidence.

Claude Code uses the same runner and scenario:

```sh
bun run eval:customization --live --harness claude-code \
  --auth-home /path/to/isolated-claude-sign-in --model <model-id>
```

Native harnesses copy only `auth.json` (Codex) or `.credentials.json` (Claude)
from `--auth-home`, defaulting to `~/.codex` or `~/.claude`. They never copy
personal configuration, project settings, or native thread history. Staged
authentication lives outside retained evidence and is removed on teardown.
An authentication directory backed only by an OS keychain is not a plaintext
sign-in file. `--command` selects an alternative native executable; otherwise
Codex uses the repository's pinned executable and Claude uses `claude` on PATH.

The builtin harness requires a model and the selected provider's environment
key. Model calls stay in the host; file and shell tools use Work's local process
provider with an outer filesystem boundary:

```sh
bun run eval:customization --live --harness builtin --provider openai \
  --model <model-id> --scenario todo-sidebar
```

Providers are `openai`, `anthropic`, and `openrouter`, with `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, and `OPENROUTER_API_KEY` respectively. Keys do not enter
the agent's shell environment. Builtin effort defaults to medium.

## Isolation and evidence

Each attempt starts in a temporary folder outside this repository. It cannot
inherit repository instructions or inspect evaluator source. On macOS, the
native harness and builtin shell commands run under an outer Seatbelt profile
that permits only their disposable project, private runtime directories,
authentication, selected executables, and OS runtime files. The native harness's
own nested sandbox is disabled because macOS does not permit nested
`sandbox-exec`. The outer boundary remains enforced. Linux native evaluation
is not implemented; the runner fails rather than weakening isolation.

The project installs packed public SDK artifacts with their real declaration
files. The source worker is bundled from the same source with the same options
as desktop releases. Agent-facing check and preview tools call Work's production
`checkCustomization` and `previewCustomization`. The preview's fixture grants
permit only declared access within the disposable project and no external hosts.
Private capabilities use the actual capability registry and its caller-bound
authorization, backed by a disposable PGlite database outside the agent's
filesystem boundary.

Workflow dependency installs and the ordinary workflow supervisor use the
local provider's PATH hook to enter a separate Seatbelt boundary. The immutable
launcher validates the canonical sandbox home and working directory before
launching Bun. Dependency installation disables lifecycle scripts and validates
installed links before the host writes runtime payloads. An invalid installation
detaches its workspace before any host restoration write. Workflow module
initialization, boundary callbacks and their children read their own sandbox
and write only its data, home, temporary and cache directories. Source and
runtime payloads stay read-only. Workflow installation and execution have no network access.
They cannot reach the evaluator, its database, other sandboxes, or live Work
listeners. Child Bun commands inherit that boundary and use the real executable
directly. Workflow execution fails on platforms without this confinement.
The workflow boundary also denies Mach service access and process inspection,
task ports and signals outside that sandbox. Bun launches use an immutable
explicit configuration; the install validator starts from its own directory
with a clean environment and cannot load a project's startup files.

Sidebar preview and grading share that real host too. `work.state` uses the
same canonical package namespace as Work, checks the state permission both
at process start and on every call, and keeps state across worker restarts.
The todo scenario accepts either host state or declared filesystem persistence.
Source host operations outside state are not supplied by this scenario.

Reports default to `test-results/customization-evals/<timestamp>/`. Each attempt
retains `report.json`, `prompt.md`, the NDJSON runner transcript, generated
source, packed SDK artifacts and hashes, worker hash, compiler diagnostics, and
runtime preview and disposable host state. Reminder runs also retain private
workflow source. Reports contain synthetic evaluation data; they are local files until
explicitly shared. Agent-generated state can be changed by behavioral grading.

## Behavioral grades

`todo-sidebar` loads generated code in the real confined worker and checks one
compact row per todo, full hover details, the linked opening target and all
opening modes, actual Rename and Done menu actions, drag ordering, and state
after a fresh source process. Work's real loader must find the section in the
generated runtime layout. The compiler checks the actual source and layout
against the installed SDK. Grades do not compare exact source text or accept
an agent's prose as evidence.

`private-reminder` checks caller-partitioned state and active member-owned
workflow source. It ticks before the due time, archives the originating chat,
closes and reopens the database and host, then ticks after the due time and
executes the ordinary workflow worker. Exactly one notification must reach the
requesting member, with no new agent turn and no Git initialization in the
plain project folder.

These are headless contract and runtime evaluations. They do not grade pixel
layout, hover animation, native pointer gestures, or approval UI. Native
Electron coverage belongs to `bun run --cwd apps/desktop test:e2e`, which runs
on the repository's isolated Docker test desktop. This runner never opens
Electron in the person's macOS session.

## Extending the suite

Scenario prompts live in `scripts/customization-eval/scenarios.ts`. Runner
transport, options, SDK installation, host tooling, and grades are separate
modules. The private host fixture is
`apps/desktop/evals/private-customization-host.ts`, beside the desktop's
declared host dependencies. Deterministic tests cover option validation,
runner completion, cancellation and teardown, and the real filesystem boundary.
They do not need model credentials:

```sh
bun scripts/tool-runtime.ts vitest --dir scripts/customization-eval \
  --config ./vitest.config.ts
```

`bun run --cwd apps/desktop test:eval` is an alias for the same parameterized
runner. The earlier API-key wizard and local-registry evaluation was removed.
The todo scenario now also requests manual Add with a title, reminder presets,
custom duration/units and date/time, repeated reminders, and inspector copying.
Its source grader exercises the actual declared form values and source restart.
It then archives the chat, reopens Core and the database, and uses the ordinary
durable timeout worker and run driver to require one custom-reminder notification
without an agent turn.
`customization-forms.e2e.ts` separately drives those controls in real Work: manual
creation, multiple reminders, native select interaction, readable/copyable hover,
semantic menu composition, full application restart and an ordinary private
workflow's durable wait and notification. Collection lifecycle tests cover context
switches without losing DOM, focus, expansion or subscription ownership. These UI
fixtures do not turn headless source checks into evidence of native interaction;
retain both result sets and hand-test generated output when assessing usability.
