"use client";

/**
 * Re-export of the headless git hook from `@catamorphic/react`. The hook
 * now talks to the typed api-client directly via `useCatamorphic()`, so the
 * playground no longer needs a host-injected adapter — this file exists only
 * to keep the existing `@/lib/use-project-git-state` import path stable.
 */
export {
  type ProjectGitState,
  type UseProjectGitStateOptions,
  useProjectGitState,
} from "@catamorphic/react";
