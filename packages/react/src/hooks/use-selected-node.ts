import type { WorkflowNode } from "@catamorphic/parser";
import { useAtom, useAtomValue } from "jotai";
import { selectedNodeAtom, selectedNodeIdAtom } from "../atoms.js";

export function useSelectedNode(): [
  WorkflowNode | null,
  (id: string | null) => void,
] {
  const node = useAtomValue(selectedNodeAtom);
  const [, setId] = useAtom(selectedNodeIdAtom);
  return [node, setId];
}
