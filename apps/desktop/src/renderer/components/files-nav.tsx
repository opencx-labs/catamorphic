import { ChevronRight, File, Folder } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { OpenMode } from "../../shared/open-mode.js";
import { desktopApi } from "../lib/desktop-api.js";
import { useLocalProjectFiles } from "../lib/local-project-files.js";
import { LazyList } from "./lazy-list.js";
import { OpenResourceButton } from "./open-resource-button.js";

interface FileTreeNode {
  name: string;
  path: string;
  children?: FileTreeNode[];
}

export function FilesNav({
  projectId,
  activePath,
  contentOnly = false,
  onOpen,
  onEmptyChange,
}: {
  projectId: string;
  activePath?: string;
  /** Member shells show work products, not the repository's implementation. */
  contentOnly?: boolean;
  onOpen: (path: string, mode?: OpenMode) => void;
  onEmptyChange?: (empty: boolean) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(["store"]),
  );
  const query = useLocalProjectFiles(projectId);
  const refetch = query.refetch;
  useEffect(
    () =>
      desktopApi.onGitChanged((event) => {
        if (event.projectId === projectId) void refetch();
      }),
    [projectId, refetch],
  );
  const tree = useMemo(
    () =>
      buildTree(
        (query.data ?? [])
          .map((entry) => entry.path)
          .filter((path) => isVisibleProjectFile(path, contentOnly)),
      ),
    [contentOnly, query.data],
  );
  useEffect(() => onEmptyChange?.(tree.length === 0), [tree, onEmptyChange]);
  const rows = useMemo(() => {
    const result: { node: FileTreeNode; depth: number }[] = [];
    const visit = (nodes: FileTreeNode[], depth: number) => {
      for (const node of nodes) {
        result.push({ node, depth });
        if (node.children && expanded.has(node.path))
          visit(node.children, depth + 1);
      }
    };
    visit(tree, 0);
    return result;
  }, [tree, expanded]);
  if (query.isLoading) return <p className="sidebar-empty-state">Loading…</p>;
  return (
    <div className="flex flex-col gap-2" data-testid="files-nav">
      <LazyList
        items={rows}
        itemKey={(row) => row.node.path}
        label="Project files"
        renderItem={({ node, depth }) => (
          <FileNode
            node={node}
            depth={depth}
            activePath={activePath}
            onOpen={onOpen}
            expanded={expanded.has(node.path)}
            onToggle={() =>
              setExpanded((current) => {
                const next = new Set(current);
                if (next.has(node.path)) next.delete(node.path);
                else next.add(node.path);
                return next;
              })
            }
          />
        )}
      />
    </div>
  );
}

function FileNode({
  node,
  depth,
  expanded,
  onToggle,
  activePath,
  onOpen,
}: {
  node: FileTreeNode;
  depth: number;
  expanded: boolean;
  onToggle: () => void;
  activePath?: string;
  onOpen: (path: string, mode?: OpenMode) => void;
}) {
  const className = `flex h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-bg-overlay/60 hover:text-fg ${activePath === node.path ? "bg-bg-overlay text-fg" : "text-fg-muted"}`;
  return (
    <div style={{ paddingLeft: depth * 12 }}>
      {node.children ? (
        <button
          type="button"
          className={className}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <ChevronRight
            className={`size-3 shrink-0 ${expanded ? "rotate-90" : ""}`}
          />
          <Folder className="size-3.5 shrink-0" />
          <span className="truncate">{node.name}</span>
        </button>
      ) : (
        <OpenResourceButton
          onOpen={(mode) => onOpen(node.path, mode)}
          className={className}
          title={node.path}
        >
          <File className="size-3.5 shrink-0" />
          <span className="truncate">{node.name}</span>
        </OpenResourceButton>
      )}
    </div>
  );
}

export function isVisibleProjectFile(
  path: string,
  contentOnly = false,
): boolean {
  return (
    !path.startsWith(".git/") &&
    !path.startsWith("node_modules/") &&
    path !== ".catamorphic/remote.json" &&
    (!contentOnly || path.startsWith("store/"))
  );
}

export function buildTree(paths: string[]): FileTreeNode[] {
  interface MutableNode {
    name: string;
    path: string;
    children?: Map<string, MutableNode>;
  }
  const root = new Map<string, MutableNode>();
  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    let current: Map<string, MutableNode> = root;
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      if (!name) continue;
      const nodePath = parts.slice(0, index + 1).join("/");
      const folder = index < parts.length - 1;
      const existing = current.get(name);
      const node: MutableNode = existing ?? {
        name,
        path: nodePath,
        ...(folder ? { children: new Map() } : {}),
      };
      if (!existing) {
        current.set(name, node);
      }
      if (folder) {
        node.children ??= new Map();
        current = node.children;
      }
    }
  }
  const materialize = (nodes: Map<string, MutableNode>): FileTreeNode[] =>
    [...nodes.values()]
      .map(
        (node): FileTreeNode => ({
          name: node.name,
          path: node.path,
          ...(node.children ? { children: materialize(node.children) } : {}),
        }),
      )
      .sort(
        (left, right) =>
          Number(Boolean(right.children)) - Number(Boolean(left.children)) ||
          left.name.localeCompare(right.name),
      );
  return materialize(root);
}
