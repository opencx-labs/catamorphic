import {
  PROJECT_APP_DATA_DIR,
  PROJECT_PERSONAL_DIR,
  PROJECT_STORE_DIR,
} from "@catamorphic/workflow/project-layout";

export interface FileTreeNode {
  name: string;
  path: string;
  children?: FileTreeNode[];
}

/** The desktop's local remote-link locator; local state, never listed. */
const REMOTE_LOCATOR_PATH = `${PROJECT_APP_DATA_DIR}/remote.json`;

export function isVisibleProjectFile(
  path: string,
  contentOnly = false,
): boolean {
  return (
    !path.startsWith(".git/") &&
    !path.startsWith("node_modules/") &&
    path !== REMOTE_LOCATOR_PATH &&
    (!contentOnly ||
      !path.startsWith(".") ||
      path.startsWith(`${PROJECT_PERSONAL_DIR}/`) ||
      path.startsWith(`${PROJECT_STORE_DIR}/`))
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
