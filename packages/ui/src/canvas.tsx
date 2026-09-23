import {
  reactFlowEdgesAtom,
  reactFlowNodesAtom,
  selectedNodeIdAtom,
} from "@catamorphic/react";
import {
  applyNodeChanges,
  Background,
  Controls,
  type CoordinateExtent,
  type FitViewOptions,
  MiniMap,
  type NodeMouseHandler,
  type NodeTypes,
  type OnNodesChange,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { nodeTypes as builtInNodeTypes } from "./nodes/index.js";
import {
  GRAPH_TRANSITION_MS,
  useGraphTransition,
} from "./use-graph-transition.js";

const FIT_VIEW_OPTIONS: FitViewOptions = {
  padding: 0.08,
  minZoom: 0.1,
  maxZoom: 1,
};

function computeTranslateExtent(
  nodes: {
    position: { x: number; y: number };
    measured?: { width?: number; height?: number };
    width?: number;
    height?: number;
    parentId?: string;
  }[],
): CoordinateExtent | undefined {
  if (nodes.length === 0) return undefined;

  const rootNodes = nodes.filter((n) => !n.parentId);
  if (rootNodes.length === 0) return undefined;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of rootNodes) {
    const w = node.measured?.width ?? node.width ?? 200;
    const h = node.measured?.height ?? node.height ?? 60;
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + w);
    maxY = Math.max(maxY, node.position.y + h);
  }

  const bboxW = maxX - minX;
  const bboxH = maxY - minY;
  const padX = Math.max(2000, bboxW * 1.5);
  const padY = Math.max(2000, bboxH * 1.5);

  return [
    [minX - padX, minY - padY],
    [maxX + padX, maxY + padY],
  ];
}

const CONTAINER_TYPES = new Set([
  "if-block",
  "loop-block",
  "parallel-block",
  "scope-block",
  "durable-boundary",
  "batch",
  "branch",
]);

/** Minimap shapes are themed in CSS; SVG fill attributes cannot read tokens. */
function minimapNodeClass(node: { type?: string }): string {
  return CONTAINER_TYPES.has(node.type ?? "")
    ? "catamorphic-minimap-container"
    : "catamorphic-minimap-node";
}

/**
 * The workflow graph. Clicking a node selects it (`selectedNodeIdAtom`) and
 * clicking empty canvas clears the selection; hosts derive their inspector
 * from that selection instead of a separate open/closed state.
 */
export function WorkflowCanvas({
  nodeRenderers,
  showMinimap = false,
}: {
  nodeRenderers?: Partial<NodeTypes>;
  /** An overview of large graphs in the bottom-right corner. */
  showMinimap?: boolean;
} = {}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [viewportReady, setViewportReady] = useState(false);
  const [nodes, setNodes] = useAtom(reactFlowNodesAtom);
  const edges = useAtomValue(reactFlowEdgesAtom);
  const animated = useGraphTransition({ nodes, edges });
  const selectedNodeId = useAtomValue(selectedNodeIdAtom);
  const setSelectedNodeId = useSetAtom(selectedNodeIdAtom);

  useEffect(() => {
    setNodes((prev) => {
      let changed = false;
      const next = prev.map((n) => {
        const shouldSelect = n.id === selectedNodeId;
        if (n.selected !== shouldSelect) {
          changed = true;
          return { ...n, selected: shouldSelect };
        }
        return n;
      });
      return changed ? next : prev;
    });
  }, [selectedNodeId, setNodes]);

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      const filtered = changes.filter(
        (c) =>
          c.type !== "position" && !("id" in c && c.id.startsWith("leaving:")),
      );
      if (filtered.length > 0) {
        setNodes((prev) => applyNodeChanges(filtered, prev));
      }
    },
    [setNodes],
  );

  const translateExtent = useMemo(() => computeTranslateExtent(nodes), [nodes]);
  const nodeTypes = useMemo<NodeTypes>(() => {
    const merged: NodeTypes = { ...builtInNodeTypes };
    for (const [type, Renderer] of Object.entries(nodeRenderers ?? {})) {
      if (Renderer) merged[type] = Renderer;
    }
    return merged;
  }, [nodeRenderers]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      setSelectedNodeId(node.id);
    },
    [setSelectedNodeId],
  );

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, [setSelectedNodeId]);

  return (
    <div
      ref={canvasRef}
      className="catamorphic-workflow-canvas"
      data-graph-transitioning={animated.transitioning}
      data-viewport-ready={viewportReady}
      style={{ position: "absolute", inset: 0 }}
    >
      <ReactFlow
        nodes={animated.nodes}
        edges={animated.edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        translateExtent={translateExtent}
        minZoom={0.1}
        maxZoom={2}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={true}
        edgesFocusable={false}
        elementsSelectable={true}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        panActivationKeyCode={null}
        zoomActivationKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <InitialVisibleFit canvasRef={canvasRef} onReady={setViewportReady} />
        {viewportReady && (
          <KeepInView
            canvasRef={canvasRef}
            selectedId={selectedNodeId}
            entered={animated.entered}
          />
        )}
        <Background />
        <Controls showInteractive={false} fitViewOptions={FIT_VIEW_OPTIONS} />
        {showMinimap && (
          <MiniMap
            nodeClassName={minimapNodeClass}
            pannable
            zoomable
            style={{ width: 120, height: 90 }}
          />
        )}
      </ReactFlow>
    </div>
  );
}

/** Hidden, retained tabs have no viewport yet. Fit once after their first
 * visible measurement, then preserve the user's viewport through later edits. */
function InitialVisibleFit({
  canvasRef,
  onReady,
}: {
  canvasRef: RefObject<HTMLDivElement | null>;
  onReady(ready: boolean): void;
}) {
  const initialized = useNodesInitialized();
  const { fitView } = useReactFlow();
  const viewportWidth = useStore((state) => state.width);
  const viewportHeight = useStore((state) => state.height);
  const fitted = useRef(false);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !initialized || fitted.current) return;
    let frame = 0;
    let disposed = false;
    const scheduleFit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bounds = canvas.getBoundingClientRect();
        if (
          disposed ||
          fitted.current ||
          bounds.width === 0 ||
          bounds.height === 0 ||
          Math.abs(viewportWidth - bounds.width) > 1 ||
          Math.abs(viewportHeight - bounds.height) > 1
        )
          return;
        // React Flow queues this fit for its next node update. Mark the request
        // now: a resize can clean up this effect before the promise resolves.
        fitted.current = true;
        void fitView(FIT_VIEW_OPTIONS).then(() => onReady(true));
      });
    };
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(canvas);
    scheduleFit();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [canvasRef, initialized, fitView, viewportWidth, viewportHeight, onReady]);
  return null;
}

const KEEP_IN_VIEW_MARGIN = 24;

/**
 * Keeps what the user is working with on screen without refitting: the
 * selection stays visible when the canvas narrows (an inspector opens) or a
 * code cursor selects a distant step, and steps an edit adds are brought into
 * view once they arrive. Pans only, never zooms, and only when needed.
 */
function KeepInView({
  canvasRef,
  selectedId,
  entered,
}: {
  canvasRef: RefObject<HTMLDivElement | null>;
  selectedId: string | null;
  entered: string[];
}) {
  const { getViewport, setViewport, fitView } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const reveal = useCallback(
    (ids: string[]) => {
      const canvas = canvasRef.current?.getBoundingClientRect();
      if (!canvas || canvas.width === 0 || canvas.height === 0) return;
      const boxes = ids.flatMap((id) => {
        const element = canvasRef.current?.querySelector(
          `.react-flow__node[data-id="${CSS.escape(id)}"]`,
        );
        return element ? [element.getBoundingClientRect()] : [];
      });
      if (boxes.length === 0) return;
      const left = Math.min(...boxes.map((box) => box.left));
      const top = Math.min(...boxes.map((box) => box.top));
      const right = Math.max(...boxes.map((box) => box.right));
      const bottom = Math.max(...boxes.map((box) => box.bottom));
      // Larger than the canvas: align its leading edge instead.
      const shift = (start: number, end: number, min: number, max: number) =>
        end - start > max - min
          ? min - start
          : end > max
            ? max - end
            : start < min
              ? min - start
              : 0;
      const dx = shift(
        left,
        right,
        canvas.left + KEEP_IN_VIEW_MARGIN,
        canvas.right - KEEP_IN_VIEW_MARGIN,
      );
      const dy = shift(
        top,
        bottom,
        canvas.top + KEEP_IN_VIEW_MARGIN,
        canvas.bottom - KEEP_IN_VIEW_MARGIN,
      );
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      const viewport = getViewport();
      const reduce = window.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      void setViewport(
        { ...viewport, x: viewport.x + dx, y: viewport.y + dy },
        { duration: reduce ? 0 : GRAPH_TRANSITION_MS },
      );
    },
    [canvasRef, getViewport, setViewport],
  );
  // Wait for a resize (such as an opening panel) to settle before panning.
  // A resize that leaves nothing on screen refits instead.
  useEffect(() => {
    if (width === 0 || height === 0) return;
    const timer = setTimeout(() => {
      if (selectedId) {
        reveal([selectedId]);
        return;
      }
      const canvas = canvasRef.current?.getBoundingClientRect();
      const nodes = canvasRef.current?.querySelectorAll(".react-flow__node");
      if (!canvas || !nodes?.length) return;
      const visible = [...nodes].some((node) => {
        const box = node.getBoundingClientRect();
        return (
          box.right > canvas.left &&
          box.left < canvas.right &&
          box.bottom > canvas.top &&
          box.top < canvas.bottom
        );
      });
      if (!visible)
        void fitView({
          ...FIT_VIEW_OPTIONS,
          duration: window.matchMedia?.("(prefers-reduced-motion: reduce)")
            .matches
            ? 0
            : GRAPH_TRANSITION_MS,
        });
    }, 120);
    return () => clearTimeout(timer);
  }, [selectedId, width, height, reveal, canvasRef, fitView]);
  useEffect(() => {
    if (entered.length === 0) return;
    const timer = setTimeout(() => reveal(entered), GRAPH_TRANSITION_MS + 40);
    return () => clearTimeout(timer);
  }, [entered, reveal]);
  return null;
}
