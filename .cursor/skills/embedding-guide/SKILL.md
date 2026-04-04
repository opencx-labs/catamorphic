# Embedding Guide

## Overview

`@catamorphic/ui` is designed to be embedded in any React application. The `WorkflowEditor` component is the main entry point.

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

## Server Setup

The embedding app should also run `@catamorphic/server` (Fastify) for persistence and use `@catamorphic/api-client` for type-safe communication.
