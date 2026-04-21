"use client";

import { ReactFlowProvider } from "@xyflow/react";
import { Provider as JotaiProvider } from "jotai";
import { createContext, type ReactNode, useContext } from "react";

/**
 * Marker context used to detect whether a `<WorkflowEditorScope>` is already
 * mounted above in the tree. Lets the scope be mounted redundantly without
 * creating a fresh (isolated) jotai store every time.
 */
const WorkflowEditorScopeContext = createContext<boolean>(false);

export interface WorkflowEditorScopeProps {
  children: ReactNode;
  /**
   * Force a fresh jotai + React Flow scope even if one is already present
   * above. Use for side-by-side editors that must not share selection,
   * graph, or run state.
   */
  isolate?: boolean;
}

/**
 * Establishes the jotai store and React Flow context used by the workflow
 * editor. Wrap this once around the editor and any host chrome (custom
 * toolbars, inspectors, sibling panels) that should read the same atoms.
 *
 * Two editors rendered inside the same scope share state. Two editors that
 * need to be independent must each be wrapped in their own scope — or the
 * outer one can pass `isolate` to opt out of an ambient scope.
 *
 * Re-mounting the scope (or nesting it without `isolate`) is a no-op: the
 * ambient store is reused via context detection.
 */
export function WorkflowEditorScope({
  children,
  isolate = false,
}: WorkflowEditorScopeProps) {
  const hasAmbientScope = useContext(WorkflowEditorScopeContext);

  if (hasAmbientScope && !isolate) {
    return <>{children}</>;
  }

  return (
    <WorkflowEditorScopeContext.Provider value={true}>
      <JotaiProvider>
        <ReactFlowProvider>{children}</ReactFlowProvider>
      </JotaiProvider>
    </WorkflowEditorScopeContext.Provider>
  );
}

/**
 * Hook form of the scope detection. Primarily useful for advanced hosts
 * that want to conditionally mount their own scope only when one is not
 * already present.
 */
export function useHasWorkflowEditorScope(): boolean {
  return useContext(WorkflowEditorScopeContext);
}
