"use client";

import { useMemo } from "react";

interface FileTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: FileTreeNode[];
}

function buildTree({ paths }: { paths: string[] }): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const filePath of [...paths].sort()) {
    const parts = filePath.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i] as string;
      const isDir = i < parts.length - 1;
      const fullPath = parts.slice(0, i + 1).join("/");

      const found = current.find((n) => n.name === name && n.isDir === isDir);
      if (found) {
        current = found.children;
      } else {
        const node: FileTreeNode = {
          name,
          path: fullPath,
          isDir,
          children: [],
        };
        current.push(node);
        current = node.children;
      }
    }
  }

  return root;
}

function TreeNode({
  node,
  depth,
  activeFile,
  modifiedFiles,
  onSelect,
}: {
  node: FileTreeNode;
  depth: number;
  activeFile: string | null;
  modifiedFiles: ReadonlySet<string>;
  onSelect: (path: string) => void;
}) {
  const isActive = node.path === activeFile;
  const isModified = modifiedFiles.has(node.path);

  if (node.isDir) {
    return (
      <div>
        <div
          className="flex items-center gap-1.5 px-2 py-1 text-xs text-neutral-500 select-none"
          style={{ paddingLeft: 8 + depth * 12 }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="currentColor"
            className="shrink-0 text-neutral-600"
            role="img"
            aria-label="Folder"
          >
            <path d="M1 3.5A1.5 1.5 0 012.5 2h3.879a1.5 1.5 0 011.06.44l1.122 1.12A1.5 1.5 0 009.62 4H13.5A1.5 1.5 0 0115 5.5v7a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
          </svg>
          <span>{node.name}</span>
        </div>
        {node.children.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            activeFile={activeFile}
            modifiedFiles={modifiedFiles}
            onSelect={onSelect}
          />
        ))}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(node.path)}
      className={`w-full text-left flex items-center gap-1.5 px-2 py-1 text-xs transition-colors ${
        isActive
          ? "bg-blue-500/10 text-blue-400"
          : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
      }`}
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="currentColor"
        className="shrink-0 text-neutral-600"
        role="img"
        aria-label="File"
      >
        <path d="M3.75 1.5a.25.25 0 00-.25.25v12.5c0 .138.112.25.25.25h8.5a.25.25 0 00.25-.25V5.5H9.25A1.75 1.75 0 017.5 3.75V1.5H3.75zM9 1.793V3.75c0 .138.112.25.25.25h1.957L9 1.793zM2 1.75C2 .784 2.784 0 3.75 0h4.586c.464 0 .909.184 1.237.513l3.414 3.414c.329.328.513.773.513 1.237v9.086A1.75 1.75 0 0111.75 16h-8A1.75 1.75 0 012 14.25V1.75z" />
      </svg>
      <span className="truncate">{node.name}</span>
      {isModified && (
        <span className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
      )}
    </button>
  );
}

export interface FileExplorerProps {
  files: Record<string, string>;
  activeFile: string | null;
  modifiedFiles: ReadonlySet<string>;
  onSelectFile: (path: string) => void;
}

export function FileExplorer({
  files,
  activeFile,
  modifiedFiles,
  onSelectFile,
}: FileExplorerProps) {
  const tree = useMemo(() => buildTree({ paths: Object.keys(files) }), [files]);

  return (
    <div className="h-full flex flex-col bg-neutral-950 border-r border-neutral-800">
      <div className="px-3 py-2 text-xs font-semibold text-neutral-500 uppercase tracking-wider border-b border-neutral-800">
        Explorer
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {tree.map((node) => (
          <TreeNode
            key={node.path}
            node={node}
            depth={0}
            activeFile={activeFile}
            modifiedFiles={modifiedFiles}
            onSelect={onSelectFile}
          />
        ))}
      </div>
    </div>
  );
}
