# Embedding Guide

## Overview

`@catamorphic/ui` is designed to be embedded in any React application. The `WorkflowEditor` component is the main entry point. Catamorphic itself is embed-only — it never runs as a standalone product.

## Basic Usage

```typescript
import { WorkflowEditor } from "@catamorphic/ui";
import "@catamorphic/ui/styles.css";

function MyApp() {
  const [code, setCode] = useState(initialCode);

  return (
    <WorkflowEditor
      code={code}
      onCodeChange={setCode}
      showCodeEditor={true}
      showMinimap={true}
      aiEnabled={true}
      onAIPrompt={async (prompt) => {
        const result = await myAIService(prompt, code);
        return result.updatedCode;
      }}
      onRun={() => executeWorkflow(code)}
    />
  );
}
```

## Props

- `code` / `onCodeChange` — controlled code state
- `showCodeEditor` — toggle the Monaco editor panel
- `showMinimap` — toggle the React Flow minimap
- `aiEnabled` / `onAIPrompt` — enable AI bar with custom handler
- `executionState` — overlay execution status on nodes
- `onRun` — callback for the Run button
- `nodeRenderers` — custom React components for node types

## Customization

- Override node renderers for custom styling per node type
- Import individual atoms from `@catamorphic/ui` for fine-grained state control
- The CSS uses `.catamorphic-` prefixed classes for easy overriding

## Backend wiring

The host app boots catamorphic in-process via one of two paths:

- **`@catamorphic/server-sdk`** (recommended) — call `createCatamorphic({ database, storage, sandboxProvider?, pluginResolver? })` once at startup (plus `await catamorphic.migrate()`), then `catamorphic.forTenant(orgId).forUser(userId)` per request.
- **`@catamorphic/fastify-plugin`** — register `catamorphicPlugin` on the host's Fastify server with `{ core, prefix: "/api" }` (or run `createApp({ core })` as a sidecar). Every request must carry `X-Catamorphic-Tenant-Id` and `X-External-User-Id` headers set from the host's auth context. The frontend talks to it through `@catamorphic/api-client`.

See [`INTEGRATION.md`](../../../INTEGRATION.md) for the end-to-end wiring example.
