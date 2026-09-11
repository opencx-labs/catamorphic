import { useEffect, useMemo } from "react";
import type { OpenMode } from "../../shared/open-mode.js";
import { desktopApi } from "../lib/desktop-api.js";
import { useLocalProjectFiles } from "../lib/local-project-files.js";
import {
  useSidebarContent,
  useSidebarRefresh,
} from "./sidebar-contribution.js";
import { SidebarItemRow } from "./sidebar-item-row.js";
import { SidebarTree } from "./sidebar-tree.js";

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
}: {
  projectId: string;
  activePath?: string;
  contentOnly?: boolean;
  onOpen: (path: string, mode?: OpenMode) => void;
}) {
  const query = useLocalProjectFiles(projectId);
  useSidebarRefresh(query.refetch);
  const refetch = query.refetch;
  useEffect(
    () =>
      desktopApi.onGitChanged((event) => {
        if (event.projectId === projectId)
          void refetch({ cancelRefetch: false });
      }),
    [projectId, refetch],
  );
  const items = useMemo(() => {
    const result: {
      id: string;
      parentId: string | null;
      name: string;
      path: string;
      hasChildren: boolean;
      collapsed: boolean;
    }[] = [];
    const visit = (nodes: FileTreeNode[], parentId: string | null) => {
      for (const node of nodes) {
        result.push({
          id: node.path,
          parentId,
          name: node.name,
          path: node.path,
          hasChildren: Boolean(node.children),
          collapsed: node.path !== "store",
        });
        if (node.children) visit(node.children, node.path);
      }
    };
    visit(
      buildTree(
        (query.data ?? [])
          .map((entry) => entry.path)
          .filter((path) => isVisibleProjectFile(path, contentOnly)),
      ),
      null,
    );
    return result;
  }, [query.data, contentOnly]);
  useSidebarContent(
    query.isError
      ? "error"
      : query.isLoading
        ? "loading"
        : items.length
          ? "ready"
          : "empty",
  );
  if (query.isError)
    return (
      <p role="alert" className="sidebar-empty-state">
        Could not load files.{" "}
        <button type="button" onClick={() => void refetch()}>
          Retry
        </button>
      </p>
    );
  if (query.isLoading) return <p className="sidebar-empty-state">Loading…</p>;
  return (
    <div data-testid="files-nav">
      <SidebarTree
        items={items}
        label="Project files"
        defaultExpanded={false}
        selectedId={activePath}
        renderItem={(item, tree) => (
          <SidebarItemRow
            itemId={item.id}
            label={item.name}
            title={item.path}
            icon={item.hasChildren ? "Folder" : "File"}
            style={{ marginLeft: tree.depth * 12 }}
            disclosure={
              tree.hasChildren
                ? { open: tree.expanded, onToggle: tree.toggle }
                : undefined
            }
            active={activePath === item.path}
            resource={!item.hasChildren}
            onOpen={(mode) =>
              item.hasChildren ? tree.toggle() : onOpen(item.path, mode)
            }
            onAction={() => {}}
          />
        )}
      />
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
