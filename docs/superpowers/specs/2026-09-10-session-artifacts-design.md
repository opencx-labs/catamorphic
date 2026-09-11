# Distribution update

The review-package distribution below is superseded by ADR 0125. Review components now install from the code-review registry pack as editable source.

# Session artifacts and generated review apps

Accepted 2026-09-11. Architecture: [ADR 0123](../../decisions/0123-session-artifacts.md).

## Source and lifecycle

`SessionArtifactsService` owns temporary source for both apps and workflows.
Each artifact has an id and a retained git ref, rather than an extra project or
an app-specific execution engine. Postgres records ownership, revisions and
retirement. Code remains ordinary TypeScript in an ordinary workspace layout.
The service starts from committed origin source and records explicitly selected
files. It never takes a snapshot of the dirty working checkout.

App creation accepts a default-exported React component and supplies the normal
Vite/Bun scaffold. Additional source, data, CSS, manifests and local libraries are
explicit files. Workflow creation accepts an exported `defineWorkflow` value.
Updates require the current revision and accept changed files; null deletes a
file. A row lock serializes source updates. If a process pushes a source revision
but fails before recording it, the next update restores the ref to the recorded
revision before proceeding.

A successful app build is immediately usable by the owning session audience.
The normal app address is `app:session-<artifact-id>`. Build failures preserve the
previous ready build. Version ids bind the served document and every brokered
workflow call or poll. Static apps require no workflow contract. Helper workflow
code and its app-api contract must be included in the selected source. Calls
use the pinned snapshot; they do not silently resolve a newer project workflow.

Creation does not run a workflow or enable automation. Run once uses the existing
immutable-run path. Watchers use the same artifact source and the normal workflow
enablement path. Their activation remains pinned when source is edited; stop and
recreate a watcher to activate a new revision. Execution environment and connection
authority still come from the host and existing run admission.

| Action | Source and result | Execution |
| --- | --- | --- |
| Close a tab or finish a turn | Retained with the session | No change |
| Close/archive the session | Reopenable | No new activation |
| Discard the artifact | Unavailable for new use; collected after work settles | Existing runs may finish |
| Delete the session | Eligible for collection | Existing runs retain their source until terminal |
| Keep in project | Agent copies selected ordinary source and reconciles dependencies | Publication and activation remain separate |

Cleanup uses the existing watcher dispatcher and is also available as a service
method. Runs carry their session artifact id, including child runs, so retirement and
read authorization follow the source identity across every revision. App bundles and storage rows are
removed with discarded apps once builds and runs settle. Retirement errors remain
in Postgres for retry. Hosts retain control over when to invoke maintenance.

## Public surfaces

- `session_artifact` is one project MCP tool with create, list, read, update,
  discard and run actions. It is bound to the current session when supplied by
  the host and verifies ownership and agent access.
- HTTP exposes session artifact list/create and artifact get/files/update/discard/run.
  Schemas generate the API client; `useSessionArtifacts` provides the headless list.
- The bound server SDK exposes `sessionArtifacts` for source and build operations.
- Desktop session inspectors list retained artifacts. An artifact surface exposes
  source, one-off workflow runs, discard, and agent-assisted edit/keep actions.
  The same workspace target resolver opens `artifact:<id>` from chat or tools.
- `AppMount` supports a full viewport and optional visible refresh of successful
  builds. The desktop uses this for immediate iteration without publishing.

## Reviews

The native review's information hierarchy follows Osama's work in ADRs 0114,
0115 and 0118. The generated Guide uses the configured headless agent to create
an ordinary app. There is no delimiter-based Markdown extraction, review-only
storage format or separate rendering runtime.

`@catamorphic/app/review` exports `ReviewShell`, `ReviewNavigation`, `DiffView`
and `ReviewFinding`, with TypeScript props. The desktop uses the same navigation
and diff implementation. The kit follows host colors, typography and radius
tokens. Diffs retain line selection, search, wrapping and unified/split layouts.
The syntax bundle is offline and bounded; unsupported languages display as text.
The sandbox stages this optional entry only when selected source imports it.

The authoring skill instructs agents to prefer project-local review libraries,
retain compared evidence, flag omitted/truncated patches, and link findings to
actual file/side/line/revision locations. It permits project-owned MDX compilation
but never evaluates imported repository prose as code. Generated discussion is a
snapshot. Credentials and real GitHub comment/approval actions remain in the host.

## Validation boundaries

Deterministic service tests cover dirty-checkout isolation, revision conflicts,
source retention, owner access, frozen app capabilities, failed rebuilds and
cleanup. The Electron review fixture authors source through the actual MCP tool,
compiles it with the ordinary app pipeline, and exercises the sandboxed guest.
The scripted author tests plumbing and interactions, not model judgment.
