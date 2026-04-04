import dagre from "dagre";
import type { WorkflowEdge, WorkflowNode } from "./types.js";

const NODE_WIDTH = 240;
const BASE_HEIGHT = 52;
const LINE_HEIGHT = 18;
const BADGE_ROW_HEIGHT = 28;
const RANK_SEP = 60;
const NODE_SEP = 30;
const BRANCH_GAP = 24;
const GROUP_PAD_X = 20;
const GROUP_PAD_TOP = 40;
const GROUP_PAD_BOTTOM = 20;
const CHILD_GAP = 40;

export interface LayoutedNode extends WorkflowNode {
  position: { x: number; y: number };
  width: number;
  height: number;
}

export interface LayoutedGraph {
  nodes: LayoutedNode[];
  edges: WorkflowEdge[];
}

interface SizeInfo {
  width: number;
  height: number;
}

function estimateNodeHeight(node: WorkflowNode): number {
  let h = BASE_HEIGHT;
  if (node.description) {
    const chars = node.description.length;
    const lines = Math.min(Math.ceil(chars / 35), 3);
    h += lines * LINE_HEIGHT;
  }
  if (node.parameters && node.parameters.length > 0) {
    h += BADGE_ROW_HEIGHT;
  }
  if (node.returnExpression) {
    h += LINE_HEIGHT;
  }
  return h;
}

function buildMaps(nodes: WorkflowNode[]) {
  const nodeMap = new Map<string, WorkflowNode>();
  const childrenOf = new Map<string, WorkflowNode[]>();

  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  for (const node of nodes) {
    if (node.parentId) {
      const siblings = childrenOf.get(node.parentId) ?? [];
      siblings.push(node);
      childrenOf.set(node.parentId, siblings);
    }
  }

  return { nodeMap, childrenOf };
}

function calculateSize(
  nodeId: string,
  nodeMap: Map<string, WorkflowNode>,
  childrenOf: Map<string, WorkflowNode[]>,
  cache: Map<string, SizeInfo>,
): SizeInfo {
  const cached = cache.get(nodeId);
  if (cached) return cached;

  const node = nodeMap.get(nodeId);
  if (!node) {
    const fallback = { width: NODE_WIDTH, height: BASE_HEIGHT };
    cache.set(nodeId, fallback);
    return fallback;
  }

  const children = childrenOf.get(nodeId) ?? [];

  let size: SizeInfo;

  if (node.type === "if-block") {
    if (children.length === 0) {
      size = { width: NODE_WIDTH, height: BASE_HEIGHT };
    } else {
      const childSizes = children.map((c) =>
        calculateSize(c.id, nodeMap, childrenOf, cache),
      );
      const totalWidth =
        childSizes.reduce((s, c) => s + c.width, 0) +
        (children.length - 1) * BRANCH_GAP;
      const maxHeight = Math.max(...childSizes.map((c) => c.height));
      size = { width: totalWidth, height: maxHeight };
    }
  } else if (node.type === "branch" || node.type === "loop-block") {
    if (children.length === 0) {
      size = {
        width: NODE_WIDTH + GROUP_PAD_X * 2,
        height: GROUP_PAD_TOP + GROUP_PAD_BOTTOM,
      };
    } else {
      const childSizes = children.map((c) =>
        calculateSize(c.id, nodeMap, childrenOf, cache),
      );
      const maxChildWidth = Math.max(...childSizes.map((c) => c.width));
      const totalChildHeight =
        childSizes.reduce((s, c) => s + c.height, 0) +
        (children.length - 1) * CHILD_GAP;
      size = {
        width: maxChildWidth + GROUP_PAD_X * 2,
        height: GROUP_PAD_TOP + totalChildHeight + GROUP_PAD_BOTTOM,
      };
    }
  } else {
    size = { width: NODE_WIDTH, height: estimateNodeHeight(node) };
  }

  cache.set(nodeId, size);
  return size;
}

function getRootAncestor(
  nodeId: string,
  nodeMap: Map<string, WorkflowNode>,
): string {
  let current = nodeId;
  let node = nodeMap.get(current);
  while (node?.parentId) {
    current = node.parentId;
    node = nodeMap.get(current);
  }
  return current;
}

function positionChildrenRecursive(
  parentId: string,
  nodeMap: Map<string, WorkflowNode>,
  childrenOf: Map<string, WorkflowNode[]>,
  sizeCache: Map<string, SizeInfo>,
  positions: Map<string, { x: number; y: number }>,
): void {
  const parent = nodeMap.get(parentId);
  if (!parent) return;

  const children = childrenOf.get(parentId) ?? [];
  const parentSize = sizeCache.get(parentId);
  if (!parentSize) return;

  if (parent.type === "if-block") {
    let x = 0;
    for (const child of children) {
      const childSize = sizeCache.get(child.id);
      if (!childSize) continue;
      positions.set(child.id, { x, y: 0 });
      x += childSize.width + BRANCH_GAP;

      if (childrenOf.has(child.id)) {
        positionChildrenRecursive(
          child.id,
          nodeMap,
          childrenOf,
          sizeCache,
          positions,
        );
      }
    }
  } else if (parent.type === "branch" || parent.type === "loop-block") {
    let y = GROUP_PAD_TOP;
    for (const child of children) {
      const childSize = sizeCache.get(child.id);
      if (!childSize) continue;
      const x = (parentSize.width - childSize.width) / 2;
      positions.set(child.id, { x, y });
      y += childSize.height + CHILD_GAP;

      if (childrenOf.has(child.id)) {
        positionChildrenRecursive(
          child.id,
          nodeMap,
          childrenOf,
          sizeCache,
          positions,
        );
      }
    }
  }
}

export function layoutGraph({
  nodes,
  edges,
}: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): LayoutedGraph {
  if (nodes.length === 0) return { nodes: [], edges };

  const { nodeMap, childrenOf } = buildMaps(nodes);

  const sizeCache = new Map<string, SizeInfo>();
  for (const node of nodes) {
    calculateSize(node.id, nodeMap, childrenOf, sizeCache);
  }

  const rootNodes = nodes.filter((n) => !n.parentId);

  const remappedEdges = new Map<string, { source: string; target: string }>();
  for (const edge of edges) {
    const rootSource = getRootAncestor(edge.source, nodeMap);
    const rootTarget = getRootAncestor(edge.target, nodeMap);
    if (rootSource !== rootTarget) {
      const key = `${rootSource}->${rootTarget}`;
      if (!remappedEdges.has(key)) {
        remappedEdges.set(key, { source: rootSource, target: rootTarget });
      }
    }
  }

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", ranksep: RANK_SEP, nodesep: NODE_SEP });

  for (const node of rootNodes) {
    const size = sizeCache.get(node.id) ?? {
      width: NODE_WIDTH,
      height: BASE_HEIGHT,
    };
    g.setNode(node.id, { width: size.width, height: size.height });
  }

  for (const edge of remappedEdges.values()) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const positions = new Map<string, { x: number; y: number }>();
  for (const node of rootNodes) {
    const graphNode = g.node(node.id);
    const size = sizeCache.get(node.id) ?? {
      width: NODE_WIDTH,
      height: BASE_HEIGHT,
    };
    positions.set(node.id, {
      x: graphNode.x - size.width / 2,
      y: graphNode.y - size.height / 2,
    });
  }

  for (const node of rootNodes) {
    if (childrenOf.has(node.id)) {
      positionChildrenRecursive(
        node.id,
        nodeMap,
        childrenOf,
        sizeCache,
        positions,
      );
    }
  }

  const layoutedNodes: LayoutedNode[] = nodes.map((node) => {
    const size = sizeCache.get(node.id) ?? {
      width: NODE_WIDTH,
      height: BASE_HEIGHT,
    };
    const position = positions.get(node.id) ?? { x: 0, y: 0 };

    return {
      ...node,
      position,
      width: size.width,
      height: size.height,
    };
  });

  return { nodes: layoutedNodes, edges };
}
