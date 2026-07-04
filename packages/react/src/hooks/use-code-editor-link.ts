"use client";

import type { SourceRange, WorkflowNode } from "@catamorphic/parser";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { graphAtom, selectedNodeAtom, selectedNodeIdAtom } from "../atoms.js";
import {
  type EditorPosition,
  findNodeAtPosition,
} from "../lib/find-node-at-position.js";

export interface CodeEditorRevealRequest {
  /** Source range of the node the editor should scroll to and highlight. */
  range: SourceRange;
  /**
   * Monotonic token: changes on every canvas-driven selection, so the
   * editor re-reveals even when the same node is clicked twice.
   */
  key: number;
}

export interface UseCodeEditorLinkResult {
  /** Currently selected workflow node, if any. */
  selectedNode: WorkflowNode | null;
  /** All nodes of the current graph (empty until the first parse). */
  nodes: WorkflowNode[];
  /**
   * Pending canvas → code reveal. When this changes, the editor should
   * scroll to `range.startLine`, select the range, place the cursor at its
   * start, and focus itself. Cursor-driven selections never emit a reveal.
   */
  reveal: CodeEditorRevealRequest | null;
  /**
   * Code → canvas half of the link: call on user-driven cursor moves. Finds
   * the smallest node containing the position and selects it without
   * echoing a reveal back into the editor. Do not call for cursor moves the
   * editor made while applying a reveal.
   */
  handleCursorPositionChange: (position: EditorPosition) => void;
  /** Directly set (or clear) the selected node by ID. */
  selectNode: (nodeId: string | null) => void;
}

/**
 * Headless state for bidirectional code ↔ canvas linking. Wire it into any
 * code editor (the registry ships a Monaco implementation): apply `reveal`
 * to the editor, and report cursor moves through
 * `handleCursorPositionChange`.
 *
 * Must be used inside a `WorkflowEditorScope` so it shares the selection
 * and graph atoms with the canvas.
 */
export function useCodeEditorLink(): UseCodeEditorLinkResult {
  const graph = useAtomValue(graphAtom);
  const selectedNode = useAtomValue(selectedNodeAtom);
  const setSelectedNodeId = useSetAtom(selectedNodeIdAtom);

  const nodes = graph?.nodes ?? [];

  const cursorDrivenRef = useRef(false);
  const revealKeyRef = useRef(0);
  const lastRevealedIdRef = useRef<string | null>(null);
  const [reveal, setReveal] = useState<CodeEditorRevealRequest | null>(null);

  const selectedNodeId = selectedNode?.id ?? null;

  useEffect(() => {
    if (cursorDrivenRef.current) {
      cursorDrivenRef.current = false;
      lastRevealedIdRef.current = selectedNode?.id ?? null;
      return;
    }
    if (!selectedNode) {
      lastRevealedIdRef.current = null;
      setReveal(null);
      return;
    }
    // Re-parses swap node object identity without the user changing
    // selection; only a changed ID is a new selection worth revealing.
    if (selectedNode.id === lastRevealedIdRef.current) return;
    lastRevealedIdRef.current = selectedNode.id;
    revealKeyRef.current += 1;
    setReveal({ range: selectedNode.sourceRange, key: revealKeyRef.current });
  }, [selectedNode]);

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const selectedIdRef = useRef(selectedNodeId);
  selectedIdRef.current = selectedNodeId;

  const handleCursorPositionChange = useCallback(
    (position: EditorPosition) => {
      const node = findNodeAtPosition({ nodes: nodesRef.current, position });
      if (!node || node.id === selectedIdRef.current) return;
      cursorDrivenRef.current = true;
      setSelectedNodeId(node.id);
    },
    [setSelectedNodeId],
  );

  return {
    selectedNode,
    nodes,
    reveal,
    handleCursorPositionChange,
    selectNode: setSelectedNodeId,
  };
}
