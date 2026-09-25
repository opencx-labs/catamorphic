---
name: embedding-guide
description: Compose Catamorphic's UI inside a host React app (WorkflowEditor and WorkflowCanvas, host-owned inspectors, shared editor atoms, styles, member workflow review and enablement, agent session lists, and registry components). Use when building or changing a host screen on top of @catamorphic/ui, @catamorphic/react, or @catamorphic/registry.
---

# Embedding Guide

The UI layer assumes a mounted `CatamorphicProvider` and an HTTP API mounted
at `/api`. Backend wiring, identity, and the provider setup are in
[using-catamorphic](../using-catamorphic/SKILL.md). Everything here is
opt-in: use the full editor, compose lower-level pieces, or build your own
screens from the headless hooks.

Start from the [embedding example](../../../packages/registry/src/examples/embedding.tsx).
The registry typecheck compiles it, so it tracks the current API better than
any fragment.

## Workflow editor

```tsx
import { useOnParse, useTriggerRun } from "@catamorphic/react";
import { WorkflowEditor } from "@catamorphic/ui";

function WorkflowScreen({ projectId, workflowName, files, code, setCode }) {
  const onParse = useOnParse({ files, workflowName });
  const triggerRun = useTriggerRun({ projectId, workflowName });
  return (
    <WorkflowEditor
      code={code}
      onCodeChange={setCode}
      onParse={onParse}
      onRun={(input) => triggerRun.mutateAsync({ input })}
      renderInspector={({ node, close, code, onCodeChange, readOnly }) =>
        node ? <HostStepInspector node={node} onClose={close} /> : null
      }
    />
  );
}
```

`WorkflowEditorProps` in [`packages/ui/src/workflow-editor.tsx`](../../../packages/ui/src/workflow-editor.tsx):

- `code`, `onCodeChange`: controlled source.
- `onParse`: turns source into a laid-out graph. The editor has no default
  parser, so without it the canvas stays empty. Use `useOnParse({ files,
  workflowName, preferredFilePath? })`. A custom parser imports `layoutGraph`
  from `@catamorphic/parser/layout`, never the `@catamorphic/parser` barrel
  (it pulls `node:fs` into the browser bundle).
- `renderInspector({ node, close, code, onCodeChange, readOnly })`: the
  host-owned inspector (ADR 0097). `node` is the selected step or null;
  `close` clears the selection. Render it only while it has a subject.
- `renderControls({ run, running, runsOpen, toggleRuns })`: the canvas's
  top-right controls. Defaults to Runs and, with `onRun`, Run. Put status and
  actions here rather than in a separate toolbar (ADR 0157).
- `onRun(input) => Promise<Run>` and `triggerParameters`: the Run dialog.
- `renderRunsPanel`, `renderBanner`, `nodeRenderers`, `executionState`,
  `showMinimap`, `readOnly`.

## Inspectors and shared state

The framework ships no Details or Code sidebar. The host owns the inspector's
layout, wording, actions, and editor. To read editor state from host chrome,
put the editor and the chrome inside one `WorkflowEditorScope`:

```tsx
import { selectedNodeAtom } from "@catamorphic/react";
import { WorkflowEditor, WorkflowEditorScope } from "@catamorphic/ui";
import { useAtomValue } from "jotai";

function Inspector() {
  const node = useAtomValue(selectedNodeAtom);
  return node ? <aside>{node.label}</aside> : null;
}

<WorkflowEditorScope>
  <WorkflowEditor {...props} />
  <Inspector />
</WorkflowEditorScope>;
```

- Atoms live in `@catamorphic/react`: `codeAtom`, `graphAtom`,
  `graphParseStateAtom`, `selectedNodeAtom`, `selectedNodeIdAtom`,
  `executionStateAtom`, `showRunDialogAtom`, plus `useSelectedNode` and
  `useWorkflowGraph`.
- `graphParseStateAtom` distinguishes updating, ready, and failed previews.
  The canvas keeps the last valid graph after a parse failure; label a stale
  preview visibly.
- For source navigation, mount the registry `monaco-editor` item or wire any
  editor to `useCodeEditorLink`.
- For a custom layout, compose `WorkflowCanvas` (and `WorkflowEditorChrome`,
  the editor without its own scope) inside `WorkflowEditorScope`.
- Keep the canvas mounted when the inspector opens or resizes. It preserves
  its viewport and animates layout changes, respecting reduced motion.
- The host also owns unsaved-buffer restoration, save and conflict feedback,
  and run setup.

## Styles

Tailwind hosts import the stylesheet from the same CSS entry as Tailwind, so
its `@source` directive registers the package's classes:

```css
@import "tailwindcss";
@import "@catamorphic/ui/styles.css";
```

Importing the stylesheet from JavaScript does not register those classes.
Shared controls use the host's theme tokens; canvas styles use
`.catamorphic-` prefixed classes you can override. Headless hooks need no
Tailwind.

## Members: review and automations

Members see deployed workflows, not program source. Compose `ProjectWorkflows`
and `WorkflowReview` from `@catamorphic/ui`; they render the scoped deployed
graph and never fetch source files. `AgentEnvironmentControl` picks an agent's
execution Environment. Use `useAgentCatalog` and `useEnvironments` for
permitted agents and Environments rather than reading `.catamorphic/agents/`
or guessing from `/me`.

Access to a workflow is not consent to run it unattended. An automation is an
enablement:

1. `usePreviewWorkflowEnablement` shows the exact deployed commit, trigger,
   agent, Environment, connections, and declared permissions, and returns a
   consent digest.
2. After the user confirms, `useCreateWorkflowEnablement` with that digest.
   `owner: { type: "project" }` creates a project automation, which needs
   `automations:write` plus every permission the workflow declares
   (ADRs 0156, 0158).
3. `useWorkflowEnablements` lists them; `useUpdateWorkflowEnablement` disables,
   reenables, or moves one to a new deployment.

`WorkflowEnablementPanel` is a ready consent UI for this flow. Connecting an
account returns the user to the pending review; never enable other workflows
implicitly. When the API is mounted under a different prefix, pass
`authorizationRedirectUri` to `CatamorphicProvider` so connection
authorization returns to it.

## Agent sessions

- `useAgentSessions(projectId)` polls the session list, which includes chats
  that workflows or other clients started. Render `attentionRequired` as
  needing the user, separate from any client-local unread marker, and clear it
  with `useAcknowledgeAgentSessionAttention(projectId)` when the user opens the
  session. Web Push, when the host configures it, deep-links to the same
  session; do not build a parallel inbox.
- `parentSessionId` is delegation hierarchy; `forkedFromSessionId` is
  transcript lineage. Do not reuse one for the other.
- Archive is a recursive server operation. `useArchiveAgentSession` may report
  the work that would stop; show that impact and retry with
  `confirmStop: true` only after the user confirms. `useUnarchiveAgentSession`
  restores it.
- Tool permission asks: `useToolPermissions` plus the registry
  `tool-permission-card` (ADR 0054).

For message delivery, queue editing, failure recovery, and what a chat host is
responsible for, read the [chat contract](../../../apps/desktop/docs/chat-state.md).
Desktop presentation there is one host's policy, not a required model.

## Registry components

`@catamorphic/registry` ships shadcn-compatible items whose source you copy
into the host and then edit. The host serves the built manifests; nothing
depends on the registry at runtime.

- Build: `bun run --filter @catamorphic/registry build` writes
  `packages/registry/dist/r/<item>.json` and `dist/catalog.json`.
- Install: `npx shadcn add <path-or-url>/r/<item>.json`, from a checkout path,
  `node_modules/@catamorphic/registry/dist/r/`, or a URL the host serves.
- Install `catamorphic-provider` first for items that use Catamorphic hooks.

Items are the folders in [`packages/registry/src/`](../../../packages/registry/src/),
each with a `registry-item.json` describing it: `agent-chat`,
`agent-question-panel`, `catamorphic-provider`, `chat-queue`, `chat-timeline`,
`code-review`, `diff-drawer`, `file-explorer`, `git-panel`, `monaco-editor`,
`plugins-settings`, `project-editor`, `resource-preview`, `runs-panel`,
`sessions-list`, `todo-progress`, `tool-permission-card`. To add one, create
`src/<name>/` with the component and `registry-item.json`, then rebuild.
