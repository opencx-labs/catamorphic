import { Check, ChevronRight, File, Folder } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PullRequestFile } from "../lib/desktop-api.js";
import { buildTree } from "./files-nav.js";
import { LazyList } from "./lazy-list.js";

/** A compact virtual tree. Folder state survives file selection and filtering. */
export function ReviewFileTree({
  files,
  selectedPath,
  onOpen,
  isReviewed,
}: {
  files: PullRequestFile[];
  selectedPath: string;
  onOpen: (file: PullRequestFile) => void;
  isReviewed: (file: PullRequestFile) => boolean;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  useLayoutEffect(() => {
    setCollapsed((current) => {
      const parents = [...current].filter((path) =>
        selectedPath.startsWith(`${path}/`),
      );
      if (!parents.length) return current;
      return new Set([...current].filter((path) => !parents.includes(path)));
    });
  }, [selectedPath]);
  const host = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(400);
  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setHeight(node.clientHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const tree = useMemo(
    () => buildTree(files.map((file) => file.path)),
    [files],
  );
  const byPath = useMemo(
    () => new Map(files.map((file) => [file.path, file])),
    [files],
  );
  const rows = useMemo(() => {
    const result: {
      path: string;
      name: string;
      folder: boolean;
      depth: number;
    }[] = [];
    const visit = (nodes: ReturnType<typeof buildTree>, depth: number) => {
      for (const initial of nodes) {
        let node = initial;
        let name = node.name;
        while (node.children?.length === 1 && node.children[0]?.children) {
          node = node.children[0];
          name += `/${node.name}`;
        }
        result.push({
          path: node.path,
          name,
          folder: Boolean(node.children),
          depth,
        });
        if (node.children && !collapsed.has(node.path))
          visit(node.children, depth + 1);
      }
    };
    visit(tree, 0);
    return result;
  }, [tree, collapsed]);
  return (
    <div ref={host} className="min-h-0 flex-1">
      <LazyList
        items={rows}
        itemKey={(row) => row.path}
        label="Changed file tree"
        scrollToIndex={rows.findIndex((row) => row.path === selectedPath)}
        rowHeight={28}
        maxHeight={height}
        renderItem={(row) => {
          const file = byPath.get(row.path);
          const expanded = !collapsed.has(row.path);
          const toggle = () =>
            setCollapsed((current) => {
              const next = new Set(current);
              if (next.has(row.path)) next.delete(row.path);
              else next.add(row.path);
              return next;
            });
          return (
            <button
              type="button"
              aria-label={row.path}
              aria-expanded={row.folder ? expanded : undefined}
              aria-current={selectedPath === row.path ? "true" : undefined}
              onKeyDown={(event) => {
                if (
                  !row.folder ||
                  !["ArrowLeft", "ArrowRight"].includes(event.key)
                )
                  return;
                event.preventDefault();
                event.stopPropagation();
                if ((event.key === "ArrowRight") !== expanded) toggle();
              }}
              onClick={() => (row.folder ? toggle() : file && onOpen(file))}
              style={{ paddingLeft: 8 + row.depth * 12 }}
              className={`flex h-7 w-full min-w-0 items-center gap-1.5 rounded px-2 text-left text-xs hover:bg-bg-overlay focus-visible:outline focus-visible:outline-accent ${selectedPath === row.path ? "bg-bg-overlay text-fg" : "text-fg-muted"}`}
            >
              {row.folder ? (
                <>
                  <ChevronRight
                    className={`size-3 shrink-0 ${expanded ? "rotate-90" : ""}`}
                  />
                  <Folder className="size-3.5 shrink-0" />
                </>
              ) : (
                <File className="ml-4 size-3.5 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              {file &&
                (isReviewed(file) ? (
                  <Check
                    aria-label="Reviewed"
                    className="size-3 text-success"
                  />
                ) : (
                  <span
                    className={`text-[10px] ${file.status === "added" ? "text-success" : file.status === "removed" ? "text-danger" : "text-fg-faint"}`}
                  >
                    {file.status === "added"
                      ? "A"
                      : file.status === "removed"
                        ? "D"
                        : "M"}
                  </span>
                ))}
            </button>
          );
        }}
      />
    </div>
  );
}
