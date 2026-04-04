# Sandbox Agent Integration

## Overview

`@catamorphic/sandbox` wraps the sandbox-agent SDK to provide AI-assisted workflow code generation and sandboxed code execution.

## Architecture

```
User "Ask AI" → CatamorphicSandbox.prompt() → sandbox-agent session → Claude Code agent
                                                                      ↓
Updated code ← Read file from sandbox ← Agent writes/edits .ts file
```

## Configuration

```typescript
import { createSandbox } from "@catamorphic/sandbox";

const sandbox = createSandbox({
  provider: "local",      // local | docker | e2b | daytona
  agent: "claude",        // claude | codex | opencode
  packages: ["zod"],      // npm packages available in sandbox
});
```

## Sandbox Packages

The sandbox starts with **zero npm packages**. Only what the JS runtime provides. The embedding application configures available packages via `SandboxConfig.packages`. This gives the host full control over the dependency surface.

## AI Prompt Flow

1. Create/resume a sandbox-agent session
2. System prompt includes workflow conventions, available packages, step library
3. User prompt + current code as context sent to the agent
4. Agent edits the workflow file in the sandbox
5. Read back updated file
6. Parser re-processes → UI updates

## System Prompt Contents

- Workflow code conventions (`"use workflow"`, `"use step"`, JSDoc tags)
- Single object parameter rule for all functions
- Per-property metadata via `@param` JSDoc tags
- List of available npm packages
- Available step functions from the user's codebase
- Constraints: keep code simple, use supported constructs only
