import { useProjectFiles } from "@catamorphic/react";
import { ChevronRight, File, Folder } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { desktopApi } from "../lib/desktop-api.js";

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
  onOpen: (path: string) => void;
  onEmptyChange?: (empty: boolean) => void;
}) {
  const query = useProjectFiles(projectId);
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
  if (query.isLoading) {
    return <p className="px-2 py-1 text-xs text-fg-faint">Loading…</p>;
  }
  if (tree.length === 0) {
    return <p className="px-2 py-1 text-xs text-fg-faint">No files yet.</p>;
  }
  return (
    <ul className="flex flex-col gap-0.5" data-testid="files-nav">
      {tree.map((node) => (
        <FileNode
          key={node.path}
          node={node}
          activePath={activePath}
          onOpen={onOpen}
        />
      ))}
    </ul>
  );
}

function FileNode({
  node,
  activePath,
  onOpen,
}: {
  node: FileTreeNode;
  activePath?: string;
  onOpen: (path: string) => void;
}) {
  const [open, setOpen] = useState(node.path === "store");
  if (node.children) {
    return (
      <li>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md px-2 text-left text-[13px] text-fg-muted hover:bg-bg-overlay/60 hover:text-fg"
          aria-expanded={open}
        >
          <ChevronRight
            className={`size-3 shrink-0 text-fg-faint transition-transform ${open ? "rotate-90" : ""}`}
          />
          <Folder className="size-3.5 shrink-0 text-fg-faint" />
          <span className="truncate">{node.name}</span>
        </button>
        {open ? (
          <ul className="ml-3 border-l border-border pl-1">
            {node.children.map((child) => (
              <FileNode
                key={child.path}
                node={child}
                activePath={activePath}
                onOpen={onOpen}
              />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(node.path)}
        className={`flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] hover:text-fg ${
          activePath === node.path
            ? "bg-bg-overlay text-fg"
            : "text-fg-muted hover:bg-bg-overlay/60"
        }`}
        title={node.path}
      >
        <File className="size-3.5 shrink-0 text-fg-faint" />
        <span className="truncate">{node.name}</span>
      </button>
    </li>
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
