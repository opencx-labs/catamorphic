import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { OpenMode } from "../../shared/open-mode.js";
import { desktopApi } from "../lib/desktop-api.js";
import {
  localEditorPath,
  useLocalProjectFiles,
} from "../lib/local-project-files.js";
import { fadeEdges } from "./catamorphic/edge-fade.js";
import { OpenResourceButton } from "./open-resource-button.js";
import {
  useSidebarContent,
  useSidebarRefresh,
} from "./sidebar-contribution.js";

/** The note is an existing project file. Personal pinning creates no new document model. */
export function SidebarNote({
  projectId,
  scope,
  path,
  visible,
  onOpenFile,
}: {
  projectId: string;
  scope: string;
  path?: string;
  visible: boolean;
  onOpenFile: (path: string, mode?: OpenMode) => void;
}) {
  const key = `catamorphic:sidebar-note:${scope}`;
  const [pinned, setPinned] = useState(() => localStorage.getItem(key) ?? "");
  const file = path ?? pinned;
  const files = useLocalProjectFiles(projectId);
  const note = useQuery({
    queryKey: ["desktop", "sidebar-note", projectId, file],
    queryFn: async () =>
      desktopApi.editorFileRead({
        filePath: await localEditorPath(projectId, file),
      }),
    enabled: Boolean(file) && visible,
  });
  useSidebarContent({
    state:
      note.isError || files.isError
        ? "error"
        : file && note.isPending
          ? "loading"
          : file
            ? "ready"
            : "empty",
    idle: !(note.isFetching || files.isFetching),
    retry: () => {
      void files.refetch();
      void note.refetch();
    },
  });
  useSidebarRefresh(note.refetch);
  const refetch = note.refetch;
  const refetchFiles = files.refetch;
  useEffect(() => {
    // Hidden tabs skip git events. Catch up when their note picker is shown.
    if (visible) void refetchFiles();
  }, [visible, refetchFiles]);
  useEffect(
    () =>
      desktopApi.onGitChanged((event) => {
        if (!visible || event.projectId !== projectId) return;
        void refetchFiles();
        if (file) void refetch();
      }),
    [projectId, file, visible, refetch, refetchFiles],
  );
  return (
    <div className="px-2 text-xs">
      {!path && (
        <>
          <select
            aria-label="Pin a project note"
            className="mb-2 w-full rounded border border-border bg-bg-raised px-1 py-1 text-fg-muted"
            value={pinned}
            onChange={(event) => {
              setPinned(event.target.value);
              localStorage.setItem(key, event.target.value);
            }}
          >
            <option value="">Pin a note</option>
            {(files.data ?? [])
              .filter((entry) => /\.(md|txt)$/i.test(entry.path))
              .map((entry) => (
                <option key={entry.path} value={entry.path}>
                  {entry.path}
                </option>
              ))}
          </select>
          {files.isError && (
            <p role="alert" className="mb-2 text-warning">
              Could not load project notes.{" "}
              <button
                type="button"
                className="underline underline-offset-2"
                aria-label="Retry loading project notes"
                onClick={() => void refetchFiles()}
              >
                Retry
              </button>
            </p>
          )}
        </>
      )}
      {file && (
        <>
          <OpenResourceButton
            type="button"
            className="mb-2 max-w-full truncate text-fg-muted hover:text-accent"
            onOpen={(mode) => onOpenFile(file, mode)}
          >
            Open {file}
          </OpenResourceButton>
          {note.isError ? (
            <p role="alert" className="text-warning">
              This note could not be read.{" "}
              <button
                type="button"
                className="underline underline-offset-2"
                aria-label="Retry reading note"
                onClick={() => void refetch()}
              >
                Retry
              </button>
            </p>
          ) : note.isLoading ? (
            <p className="text-fg-faint">Loading note…</p>
          ) : (
            // A long note scrolls in place and fades the edge it
            // continues past, as every sidebar list does (ADR 0237).
            <div
              ref={(scroller) => (scroller ? fadeEdges(scroller) : undefined)}
              className="sidebar-note cat-edge-fade max-h-96 overflow-y-auto break-words"
            >
              <ReactMarkdown
                components={{
                  a: ({ children }) => <span>{children}</span>,
                  img: ({ alt }) => <span>{alt}</span>,
                }}
              >
                {note.data?.content ?? ""}
              </ReactMarkdown>
            </div>
          )}
        </>
      )}
    </div>
  );
}
