---
name: embedding-guide
description: Use when embedding or composing Catamorphic's WorkflowEditor and headless React hooks inside a host UI, including editor props, state control, styling, and AI or run callbacks.
---

# Embedding Guide

## Overview

`@catamorphic/ui` is designed to be embedded in any React application. The
`WorkflowEditor` component is the main entry point. Catamorphic itself is
embed-only: the host owns identity, Postgres, backend providers, worker
lifecycle, and deployment.

## Basic Usage

```typescript
import { WorkflowEditor } from "@catamorphic/ui";
import { useOnParse, useTriggerRun } from "@catamorphic/react";
import "@catamorphic/ui/styles.css";

function MyApp({ projectId, workflowName, files }) {
  const [code, setCode] = useState(initialCode);
  const onParse = useOnParse({ files, workflowName });
  const triggerRun = useTriggerRun({ projectId, workflowName });

  return (
    <WorkflowEditor
      code={code}
      onCodeChange={setCode}
      onParse={onParse}
      showCodeEditor
      showMinimap
      aiEnabled
      onAIPrompt={async (prompt) => {
        const result = await myAIService(prompt, code);
        return result.updatedCode;
      }}
      onRun={(input) => triggerRun.mutateAsync({ input })}
    />
  );
}
```

## Props

- `code` / `onCodeChange` — controlled code state
- `onParse` — required code-to-graph callback; normally use `useOnParse`
- `showCodeEditor` — toggle the Monaco editor panel
- `showMinimap` — toggle the React Flow minimap
- `aiEnabled` / `onAIPrompt` — enable AI bar with custom handler
- `executionState` — overlay execution status on nodes
- `onRun` — callback for the Run button
- `nodeRenderers` — custom React components for node types

## Customization

- Override node renderers for custom styling per node type
- Import atoms from `@catamorphic/react`; share them with host chrome by placing
  the editor and chrome inside one `WorkflowEditorScope`
- The CSS uses `.catamorphic-` prefixed classes for easy overriding

## Backend wiring

The host app boots catamorphic in-process via one of two paths:

- **`@catamorphic/server-sdk`** (recommended): call `createCatamorphic({ database, storage, environmentProvider, sandboxProvider?, pluginResolver? })` once at startup, run `await catamorphic.migrate()`, explicitly start `catamorphic.startExecutionWorker(...)` in worker processes, then use `catamorphic.forTenant({ tenantId }).forUser({ externalUserId, scope? })` per request. `environmentProvider` is required even when a host uses the static single-node helper. Missing `scope` is host-root authority, not ordinary builder access. Public methods take keyed objects and Runs live on `scoped.runs`.
- **`@catamorphic/fastify-plugin`** — register `catamorphicPlugin` on the host's Fastify server with `{ core, prefix: "/api", identity }` (or run `createApp({ core, identity })` as a sidecar). `identity` is the required resolver that turns each request into `{ tenantId, externalUserId, scope? }` from the host's own session (or `identityFromHeaders()` behind a trusted gateway). The frontend talks to it through `@catamorphic/api-client`.

## Workflow and Run model

All exports are Workflows and every invocation is a Run. Every workflow is an
exported `defineWorkflow(({ defineBoundary, defineBatch }) => ({ steps: [...] }))`
value, and every run executes a deployed commit:

- `defineBoundary` is one atomic retry scope whose callback operations retry together.
- `defineBatch` is a finite paged per-item processing scope with an optional sink.
- `defineBatchStep` physically coalesces compatible calls only inside `defineBatch.process`.
- `"use step"` functions hold IO, called from boundary run bodies.

The HTTP API, `scoped.runs`, React `useRun*` hooks, history, and Runs panel are
shared. Capabilities determine available controls; there is no public stage or
separate Run family.

## Session attention in host UIs

`useAgentSessions(projectId)` polls for sessions that workflows or other
clients created. A session with `attentionRequired: true` is the durable
notification record and should be presented as needing interaction, distinct
from any client-local unread marker. When the user opens it, call
`useAcknowledgeAgentSessionAttention(projectId)` with the session id. Web Push
deep-links to the same session and must not create a parallel notification
inbox. Desktop-like hosts may also add the session to a dock without moving
focus.

## Session hierarchy and archive

Treat delegated work as ordinary durable sessions. `parentSessionId` is the
immediate hierarchy; `forkedFromSessionId` is transcript lineage and must not
be reused for delegation. Latent children can stay in a compact parent rail;
promoted children join navigation. Archive is a recursive server operation,
not a client-local filter: call `useArchiveAgentSession`, show its typed impact
when confirmation is required, and retry with `confirmStop` only after user
confirmation. `useUnarchiveAgentSession` restores navigation, while a later
message re-anchors execution.

## Workflow enablement

Role access is not unattended-run consent. Use
`usePreviewWorkflowEnablement` to show the exact deployed commit, trigger,
agent, Environment, and connection requirements; create the enablement with
the returned consent digest only after confirmation. Use
`useWorkflowEnablements` and `useUpdateWorkflowEnablement` for disable,
reenable, and deployment-update flows. Connecting an account may complete a
pending enablement but must never enable every compatible workflow by itself.

See [`INTEGRATION.md`](../../../INTEGRATION.md) for the end-to-end wiring example.
