"use client";

import { layoutGraph } from "@catamorphic/parser/layout";
import { useCallback, useEffect, useRef } from "react";
import { useParseWorkflow } from "./use-parse-workflow.js";
import type { OnParseCallback, ParseResult } from "./use-workflow-graph.js";

export interface UseOnParseOptions {
  /**
   * Full project file map sent to the server on every parse. The current
   * editor source is spliced into this map under `preferredFilePath` before
   * the request is issued, so callers don't need to keep this in sync with
   * the live buffer.
   */
  files: Record<string, string>;
  /** Exported workflow function name to resolve against the parsed project. */
  workflowName: string;
  /**
   * File in `files` that holds the workflow export. Optional when the
   * workflow is the only one in the project; required for multi-workflow
   * projects to disambiguate.
   */
  preferredFilePath?: string;
}

/**
 * Ready-made `onParse` callback for `<WorkflowEditor>`. Wraps
 * `useParseWorkflow` → `layoutGraph` so hosts don't have to re-implement the
 * ~15 lines of glue that every integration previously duplicated (parse →
 * null-check → layout → repack into `{ graph, layoutedNodes, layoutedEdges }`).
 *
 * The returned callback is stable across renders — `files` is captured via a
 * ref so keystroke-rate churn in the host's file map doesn't re-subscribe
 * `useWorkflowGraph` or cancel in-flight parses.
 *
 * @example
 *   const onParse = useOnParse({ files, workflowName, preferredFilePath });
 *   return <WorkflowEditor code={code} onCodeChange={setCode} onParse={onParse} ... />
 */
export function useOnParse({
  files,
  workflowName,
  preferredFilePath,
}: UseOnParseOptions): OnParseCallback {
  const parse = useParseWorkflow();
  const { mutateAsync } = parse;

  // Mirror `files` through a ref: we want the callback to always see the
  // latest project files without re-subscribing the debounced parse effect
  // in `useWorkflowGraph` on every keystroke in an unrelated file.
  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  return useCallback<OnParseCallback>(
    async (source): Promise<ParseResult | null> => {
      // Splice the live editor source into the project map so the parser
      // sees unsaved edits. Without `preferredFilePath` we send the project
      // as-is; the parser will resolve the workflow wherever it's exported.
      const mergedFiles = preferredFilePath
        ? { ...filesRef.current, [preferredFilePath]: source }
        : filesRef.current;

      try {
        const parsed = await mutateAsync({
          files: mergedFiles,
          workflowName,
          preferredFilePath,
        });
        if (!parsed) return null;
        const layouted = layoutGraph({
          nodes: parsed.nodes,
          edges: parsed.edges,
        });
        return {
          graph: parsed,
          layoutedNodes: layouted.nodes,
          layoutedEdges: layouted.edges,
        };
      } catch {
        // Parse errors are expected mid-edit; `useWorkflowGraph` treats a
        // null return as "keep the last good graph", which is what we want.
        return null;
      }
    },
    [mutateAsync, workflowName, preferredFilePath],
  );
}
