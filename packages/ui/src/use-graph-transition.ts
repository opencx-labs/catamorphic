import type { WorkflowNode } from "@catamorphic/parser";
import { workflowNodeKeys } from "@catamorphic/react";
import type { Edge, Node } from "@xyflow/react";
import { useLayoutEffect, useRef, useState } from "react";

const DURATION = 220;
type Pose = {
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
};
type Frame = {
  poses: Map<string, Pose>;
  leaving: Node[];
  leavingEdges: Edge[];
};

function pose(node: Node): Pose {
  return {
    x: node.position.x,
    y: node.position.y,
    width:
      typeof node.style?.width === "number"
        ? node.style.width
        : (node.measured?.width ?? 240),
    height:
      typeof node.style?.height === "number"
        ? node.style.height
        : (node.measured?.height ?? 44),
    opacity: typeof node.style?.opacity === "number" ? node.style.opacity : 1,
  };
}

/** Interpolate the layout itself so edges follow their nodes on every frame. */
export function useGraphTransition({
  nodes,
  edges,
  graphNodes,
}: {
  nodes: Node[];
  edges: Edge[];
  graphNodes: WorkflowNode[];
}) {
  const keys = workflowNodeKeys(graphNodes);
  const signature = JSON.stringify(
    nodes.map((node) => [
      node.id,
      keys.get(node.id),
      node.parentId,
      pose(node),
    ]),
  );
  const [frame, setFrame] = useState<Frame | null>(null);
  const rendered = useRef<{
    nodes: Node[];
    edges: Edge[];
    keys: Map<string, string>;
  }>({ nodes: [], edges: [], keys: new Map() });
  const targets = useRef({ nodes, edges, keys });
  targets.current = { nodes, edges, keys };

  // biome-ignore lint/correctness/useExhaustiveDependencies: animate only layout changes; selection and measurement events keep the current frame
  useLayoutEffect(() => {
    const target = targets.current;
    const previous = rendered.current;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (previous.nodes.length === 0 || reduce?.matches) {
      setFrame(null);
      return;
    }
    const byKey = new Map(
      previous.nodes.map((node) => [
        previous.keys.get(node.id) ?? node.id,
        node,
      ]),
    );
    const matched = new Set<string>();
    const starts = new Map<string, Pose>();
    for (const node of target.nodes) {
      const before = byKey.get(target.keys.get(node.id) ?? node.id);
      if (before) matched.add(before.id);
      starts.set(
        node.id,
        before ? pose(before) : { ...pose(node), opacity: 0 },
      );
    }
    const removed = previous.nodes.filter((node) => !matched.has(node.id));
    const ghostIds = new Map(
      removed.map((node) => [node.id, `leaving:${node.id}`]),
    );
    // A departing child's surviving parent is mapped to its current parser id.
    const currentIds = new Map(
      target.nodes.map((node) => [target.keys.get(node.id), node.id]),
    );
    const leaving = removed.map((node) => ({
      ...node,
      id: ghostIds.get(node.id) ?? node.id,
      parentId: node.parentId
        ? (ghostIds.get(node.parentId) ??
          currentIds.get(previous.keys.get(node.parentId)))
        : undefined,
      selected: false,
      selectable: false,
      focusable: false,
      style: { ...node.style, pointerEvents: "none" as const },
    }));
    const edgeKey = (edge: Edge, nodeKeys: Map<string, string>) =>
      JSON.stringify([
        nodeKeys.get(edge.source),
        nodeKeys.get(edge.target),
        edge.label,
      ]);
    const remainingEdges = new Set(
      target.edges.map((edge) => edgeKey(edge, target.keys)),
    );
    const endpoint = (id: string) =>
      ghostIds.get(id) ?? currentIds.get(previous.keys.get(id));
    const leavingEdges = previous.edges.flatMap((edge) => {
      const source = endpoint(edge.source);
      const targetId = endpoint(edge.target);
      return !remainingEdges.has(edgeKey(edge, previous.keys)) &&
        source &&
        targetId
        ? [
            {
              ...edge,
              id: `leaving:${edge.id}`,
              source,
              target: targetId,
              selectable: false,
            },
          ]
        : [];
    });
    const started = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / DURATION);
      if (progress === 1) {
        setFrame(null);
        return;
      }
      // Exact CSS cubic-bezier(0.2, 0, 0, 1), solved for elapsed x.
      let low = 0;
      let high = 1;
      for (let i = 0; i < 12; i++) {
        const t = (low + high) / 2;
        const x = 0.6 * (1 - t) ** 2 * t + t ** 3;
        if (x < progress) low = t;
        else high = t;
      }
      const t = (low + high) / 2;
      const eased = 3 * (1 - t) * t ** 2 + t ** 3;
      const poses = new Map<string, Pose>();
      for (const node of target.nodes) {
        const from = starts.get(node.id) ?? pose(node);
        const to = pose(node);
        const mix = (a: number, b: number) => a + (b - a) * eased;
        poses.set(node.id, {
          x: mix(from.x, to.x),
          y: mix(from.y, to.y),
          width: mix(from.width, to.width),
          height: mix(from.height, to.height),
          opacity: mix(from.opacity, 1),
        });
      }
      setFrame({
        poses,
        leaving: leaving.map((node) => ({
          ...node,
          style: { ...node.style, opacity: (1 - eased) * pose(node).opacity },
        })),
        leavingEdges: leavingEdges.map((edge) => ({
          ...edge,
          style: { ...edge.style, opacity: 1 - eased },
        })),
      });
      raf = requestAnimationFrame(tick);
    };
    tick(started);
    const stop = () => {
      cancelAnimationFrame(raf);
      setFrame(null);
    };
    reduce?.addEventListener("change", stop);
    return () => {
      cancelAnimationFrame(raf);
      reduce?.removeEventListener("change", stop);
    };
  }, [signature]);

  const visibleNodes = nodes.map((node) => {
    const current = frame?.poses.get(node.id);
    return current
      ? {
          ...node,
          position: { x: current.x, y: current.y },
          style: {
            ...node.style,
            width: current.width,
            height: current.height,
            opacity: current.opacity,
          },
        }
      : node;
  });
  // Keep only live nodes as the source for interruptions; departing snapshots
  // are disposable and never enter the headless graph or selection state.
  useLayoutEffect(() => {
    rendered.current = { nodes: visibleNodes, edges, keys };
  });
  return {
    nodes: [...visibleNodes, ...(frame?.leaving ?? [])],
    edges: [
      ...edges.map((edge) => ({
        ...edge,
        style: {
          ...edge.style,
          opacity: Math.min(
            frame?.poses.get(edge.source)?.opacity ?? 1,
            frame?.poses.get(edge.target)?.opacity ?? 1,
          ),
        },
      })),
      ...(frame?.leavingEdges ?? []),
    ],
    transitioning: frame !== null,
  };
}
