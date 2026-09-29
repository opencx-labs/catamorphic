import { FileCode, Search } from "lucide-react";
import { useMemo } from "react";
import { BUILTIN_PALETTE_TRIGGERS } from "../../../shared/palette.js";
import { desktopApi } from "../../lib/desktop-api.js";
import { usePaletteHost } from "../host.js";
import { PALETTE_RESULT_LIMIT } from "../rank.js";
import type { PaletteItem, PaletteMode } from "../types.js";

/** Filenames and file content in this project, searched by main. */
export function useFileModes(): PaletteMode[] {
  const { projectId, onOpenUrl } = usePaletteHost();
  return useMemo(
    () =>
      (["files", "content"] as const).map(
        (id): PaletteMode => ({
          id,
          chip: id === "files" ? "Files" : "File content",
          icon: id === "files" ? FileCode : Search,
          label: id === "files" ? "Find files" : "Search file content",
          description:
            id === "files"
              ? "Find a filename in this project"
              : "Find text and open its matching line",
          placeholder:
            id === "files" ? "Search filenames…" : "Search inside files…",
          names: projectId ? BUILTIN_PALETTE_TRIGGERS[id] : undefined,
          rows: {
            kind: "load",
            key: `${id}:${projectId}`,
            filtered: true,
            idle: "Type to search this project",
            empty: "No matches",
            load: async (typed, signal) => {
              if (!projectId) throw new Error("Open a project to search it.");
              signal.addEventListener(
                "abort",
                () => void desktopApi.cancelFileSearch().catch(() => {}),
                { once: true },
              );
              const result = await desktopApi.fileSearch({
                projectId,
                query: typed,
                mode: id,
              });
              return {
                notice:
                  result.truncated ||
                  result.matches.length > PALETTE_RESULT_LIMIT
                    ? `Showing the first ${Math.min(result.matches.length, PALETTE_RESULT_LIMIT)} matches. Refine your query to see more.`
                    : undefined,
                items: result.matches.map(
                  (match): PaletteItem => ({
                    id: `file:${match.path}:${match.line ?? 0}`,
                    icon: FileCode,
                    label: match.line
                      ? `${match.path}:${match.line}`
                      : match.path,
                    detail: match.text ?? "File",
                    keywords: [],
                    kind: "navigate",
                    run: (commitMode) =>
                      onOpenUrl(
                        `file:${match.path}${match.line ? `:${match.line}` : ""}`,
                        commitMode,
                      ),
                  }),
                ),
              };
            },
          },
        }),
      ),
    [projectId, onOpenUrl],
  );
}
