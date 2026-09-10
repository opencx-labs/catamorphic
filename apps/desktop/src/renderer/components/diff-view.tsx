import {
  type CodeViewItem,
  parseDiffFromFile,
  parsePatchFiles,
} from "@pierre/diffs";
import {
  CodeView,
  type CodeViewHandle,
  type CodeViewReactOptions,
} from "@pierre/diffs/react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { SearchInput } from "./search-input.js";
/** One renderer for local revisions and remote patches, without a network highlighter. */
export function DiffView({
  path,
  before,
  after,
  patch,
  location,
  status,
  previousPath,
  options: overrides,
  layout,
  wrap,
  onLayoutChange,
  onWrapChange,
  toolbar,
  findShortcut,
  showToolbar = true,
  searchQuery,
}: {
  options: CodeViewReactOptions<undefined, undefined>;
  layout: "split" | "unified";
  wrap: boolean;
  onLayoutChange: (layout: "split" | "unified") => void;
  onWrapChange: (wrap: boolean) => void;
  toolbar?: ReactNode;
  findShortcut?: string;
  showToolbar?: boolean;
  searchQuery?: string;
  path: string;
  status?: string;
  previousPath?: string;
  before?: string;
  after?: string;
  patch?: string;
  location?: { line: number; side: "additions" | "deletions" };
}) {
  const [localQuery, setQuery] = useState("");
  const query = searchQuery ?? localQuery;
  const [match, setMatch] = useState(0);
  const options: CodeViewReactOptions<undefined, undefined> = {
    diffStyle: layout,
    overflow: wrap ? "wrap" : "scroll",
    enableLineSelection: true,
    lineDiffType: "word-alt",
    unsafeCSS:
      ":host { --diffs-font-family: var(--font-mono, monospace); --diffs-font-size: 13px; }",
    ...overrides,
  };
  const viewer = useRef<CodeViewHandle<undefined, undefined>>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [revision, setRevision] = useState({
    path,
    before,
    after,
    patch,
    status,
    previousPath,
    version: 0,
  });
  if (
    revision.path !== path ||
    revision.before !== before ||
    revision.after !== after ||
    revision.patch !== patch ||
    revision.status !== status ||
    revision.previousPath !== previousPath
  ) {
    setRevision({
      path,
      before,
      after,
      patch,
      status,
      previousPath,
      version: revision.version + 1,
    });
  }
  const items = useMemo<CodeViewItem<undefined>[]>(() => {
    const diffs =
      patch !== undefined
        ? parsePatchFiles(patch).flatMap((entry) => entry.files)
        : [
            parseDiffFromFile(
              { name: path, contents: before ?? "" },
              { name: path, contents: after ?? "" },
            ),
          ];
    return diffs.map((fileDiff, index) => ({
      id: `${path}:${index}`,
      type: "diff",
      version: revision.version,
      fileDiff: {
        ...fileDiff,
        ...(previousPath ? { prevName: previousPath } : {}),
        type:
          status === "added"
            ? "new"
            : status === "removed"
              ? "deleted"
              : status === "renamed"
                ? "rename-changed"
                : fileDiff.type,
      },
    }));
  }, [path, before, after, patch, revision.version, status, previousPath]);
  const matches = useMemo(() => {
    if (!query.trim()) return [];
    const needle = query.toLowerCase();
    const rows: {
      line: number;
      text: string;
      side: "additions" | "deletions";
    }[] = [];
    if (patch !== undefined) {
      let oldLine = 0;
      let newLine = 0;
      let inHunk = false;
      for (const text of patch.split("\n")) {
        const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
        if (header) {
          oldLine = Number(header[1]);
          newLine = Number(header[2]);
          inHunk = true;
          continue;
        }
        if (!inHunk || !["+", "-", " "].includes(text[0] ?? "")) continue;
        const deleted = text.startsWith("-");
        if (text.slice(1).toLowerCase().includes(needle))
          rows.push({
            line: deleted ? oldLine : newLine,
            text: text.slice(1),
            side: deleted ? "deletions" : "additions",
          });
        if (!text.startsWith("+")) oldLine++;
        if (!deleted) newLine++;
      }
    } else {
      for (const [side, contents] of [
        ["additions", after ?? ""],
        ["deletions", before ?? ""],
      ] as const) {
        contents.split("\n").forEach((text, index) => {
          if (text.toLowerCase().includes(needle))
            rows.push({ line: index + 1, text, side });
        });
      }
    }
    return rows;
  }, [query, before, after, patch]);
  const selected = query
    ? matches[match % Math.max(matches.length, 1)]
    : location
      ? { ...location, text: "" }
      : undefined;
  const itemId = items[0]?.id;
  useEffect(() => {
    if (selected && itemId)
      viewer.current?.scrollTo({
        type: "line",
        id: itemId,
        lineNumber: selected.line,
        side: selected.side,
        align: "center",
      });
  }, [selected, itemId]);
  return (
    <section
      aria-label="Code changes"
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col"
      data-testid="code-diff"
    >
      {showToolbar && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 bg-bg-raised px-3 py-2 text-xs">
          <select
            aria-label="Diff layout"
            value={layout}
            onChange={(event) =>
              onLayoutChange(
                event.target.value === "split" ? "split" : "unified",
              )
            }
            className="field rounded-md px-2 py-1"
          >
            <option value="split">Side by side</option>
            <option value="unified">Unified</option>
          </select>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={wrap}
              onChange={(event) => onWrapChange(event.target.checked)}
            />
            Wrap lines
          </label>
          {toolbar}
          <SearchInput
            shortcut={findShortcut}
            data-search-action="search-diff"
            ref={searchInput}
            aria-label="Find in diff"
            onKeyDown={(event) => {
              if (event.key === "Enter" && matches.length) {
                event.preventDefault();
                setMatch(
                  (value) =>
                    (value + (event.shiftKey ? -1 : 1) + matches.length) %
                    matches.length,
                );
              }
              if (event.key === "Escape") {
                setQuery("");
                event.stopPropagation();
              }
            }}
            placeholder="Find in diff…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setMatch(0);
            }}
            className="field ml-auto min-w-0 rounded-md px-2 py-1"
          />
          {query && (
            <>
              <span role="status">
                {matches.length
                  ? `${(match % matches.length) + 1} / ${matches.length}`
                  : "No matches"}
              </span>
              <button
                type="button"
                disabled={!matches.length}
                data-disabled-reason={
                  !matches.length ? "No matching lines" : undefined
                }
                onClick={() => setMatch((value) => value + 1)}
              >
                Next
              </button>
            </>
          )}
        </div>
      )}
      {selected && (
        <p className="truncate bg-bg-overlay px-3 py-1 font-mono text-xs">
          Line {selected.line}: {selected.text}
        </p>
      )}
      <CodeView
        ref={viewer}
        className="min-h-0 flex-1 overflow-auto"
        items={items}
        options={options}
        selectedLines={
          selected && itemId
            ? {
                id: itemId,
                range: {
                  start: selected.line,
                  end: selected.line,
                  side: selected.side,
                },
              }
            : null
        }
      />
    </section>
  );
}
