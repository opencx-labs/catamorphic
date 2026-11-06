# Background execution

Work has one embedded engine for its local database, workflow workers,
schedules and approved customization services. Closing a source or archiving
the chat that created a member-owned workflow does not own that work's lifetime.

## Workflow and process lifetimes

Member-owned private workflows use the ordinary deployment, consent,
enablement, schedule and Run services. Their source and state remain private
to the member. Enabled workflows can keep running after the UI quits.

`work.processes` starts commands under the calling package's approved module
confinement. `start({ key, command, name?, lifetime })`, `list()`,
`read({ key, cursor?, maxBytes?, waitMs? })` and `stop({ key })` use the ordinary
sandbox process records and byte cursors. Keys belong to the canonical package
within its profile and project. Calls from another package cannot control them.
The command receives a private home and temporary directory, its declared file
and network reach, and a clean environment.
On macOS, native source and command confinement denies process creation. A managed
command replaces its launcher (`exec bun monitor.ts`), retaining the supervised
PID. Detached children cannot escape cleanup. Linux supports process trees inside
its PID namespace. Workflows provide isolated multi-process execution on either
platform; native shell pipelines and tools that launch children belong there.

| Lifetime | Ownership |
| --- | --- |
| `view` | The source's running module. Its last subscription or request ending lets the idle module and its processes stop. |
| `application` | An explicitly enabled package service. Its desired definition is retained in member state and restored by Work's engine. |

Packages declare `processes` in `catamorphic.access.permissions`; application
services also declare `background`. The existing signed package approval is
required. A restart rechecks the current canonical paths, declaration and
approval. Revocation stops a running service; a changed declaration replaces
its confinement before it runs again. `stop` removes the desired definition
before terminating the process group, so it disables supervised restarts.

An enabled application service restarts after it exits or after the engine
transfers. Each attempt has a new process id and output cursor. It is an OS
process, so a restart can repeat side effects. Workflow boundaries, durable
waits and idempotency remain the model for durable jobs and reminders.

## Quit and reopen

When approved enabled work remains, Quit first closes the foreground services
and flushes the database. Only a successful shutdown releases the instance
lock and starts the same signed Work executable with `--background-runtime`.
That new process creates no windows and starts the same engine against the
same database. There is no second database or scheduler. Foreground and
background processes never open PGlite concurrently.

The helper restores enabled services and ordinary workflows. It has no
renderer, browser, terminal or voice UI. A foreground launch reaches it through
Electron's single-instance event; it closes and flushes its engine before
relaunching the UI. Processes restart across this transfer. The helper exits
when no approved enabled work remains. Work does not install a login service
or promise execution while the computer is off.

Host diagnostics use the private `background-runtime.json` control record in
the user-data directory. `callBackgroundRuntime` supports authenticated local
inspection and clean shutdown; the token never enters a guest API or command
line. Source code has its own `list`, `read` and `stop` methods. Host inspection
can still identify service ownership when its original source is gone.

## Verification

The process-manager tests exercise real commands, byte-cursor output,
descendant cleanup, view disposal, conditional state writes, restart and
revocation. macOS and the isolated Linux confinement lane also run a real
confined service. The handoff test exits one OS process and proves work
continues in a distinct windowless helper.

`e2e/background-runtime.e2e.ts` quits the actual Electron process, then checks
that a private schedule runs in a new helper with zero windows. Ordinary E2E
profiles disable helpers; this suite opts in with
`CATAMORPHIC_E2E_BACKGROUND_RUNTIME=1` and cleans up its helper explicitly.
