import { ChevronRight, GitPullRequest, MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  desktopApi,
  type PullRequestFile,
  type PullRequestSummary,
  type SidebarMenuEntry,
} from "../lib/desktop-api.js";
import { ShortcutHint } from "./shortcut-hint.js";
import { MenuPortal } from "./sidebar-item-row.js";
import type { WorkspaceTab } from "./workspace-tabs.js";

/**
 * The sidebar's Pull Requests section: the project's open PRs (via the
 * linked remote's host), expandable into their changed files. Clicking
 * a file opens its patch as a read-only diff tab; the ⋯ menu (or a
 * right-click) opens the PR on GitHub in a browser tab.
 */

const REFRESH_MS = 60_000;

const PR_MENU: SidebarMenuEntry[] = [
  { label: "Open on GitHub", action: "open-tab" },
];

const statusBadge = (status: string): { letter: string; className: string } =>
  status === "added"
    ? { letter: "A", className: "text-success" }
    : status === "removed"
      ? { letter: "D", className: "text-danger" }
      : status === "renamed"
        ? { letter: "R", className: "text-warning" }
        : { letter: "M", className: "text-info" };

export function PrsNav({
  projectId,
  onOpenDiff,
  onOpenUrl,
  onEmptyChange,
}: {
  projectId: string;
  onOpenDiff: (tab: WorkspaceTab) => void;
  onOpenUrl: (url: string, mode: "tab" | "replace") => void;
  /** Reports emptiness up so hide-when-empty sections can drop entirely. */
  onEmptyChange?: (empty: boolean) => void;
}) {
  const [prs, setPrs] = useState<PullRequestSummary[] | null>(null);
  const isEmpty = !prs || prs.length === 0;
  useEffect(() => {
    onEmptyChange?.(isEmpty);
  }, [isEmpty, onEmptyChange]);

  useEffect(() => {
    let cancelled = false;
    setPrs(null);
    const load = () =>
      void desktopApi
        .prList(projectId)
        .then((next) => {
          if (!cancelled) setPrs(next);
        })
        .catch(() => {});
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectId]);

  if (!prs) return null;
  if (prs.length === 0) {
    return (
      <p className="px-2 py-1 text-xs text-fg-faint">No open pull requests.</p>
    );
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {prs.map((pr) => (
        <PrRow
          key={pr.number}
          pr={pr}
          projectId={projectId}
          onOpenDiff={onOpenDiff}
          onOpenUrl={onOpenUrl}
        />
      ))}
    </ul>
  );
}

function PrRow({
  pr,
  projectId,
  onOpenDiff,
  onOpenUrl,
}: {
  pr: PullRequestSummary;
  projectId: string;
  onOpenDiff: (tab: WorkspaceTab) => void;
  onOpenUrl: (url: string, mode: "tab" | "replace") => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // Fetched once per mount, on first expand; a PR's file list changes
  // far slower than the expand/collapse toggle.
  const [files, setFiles] = useState<PullRequestFile[] | null>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-sidebar-menu]")
      ) {
        return;
      }
      if (
        event.target instanceof Node &&
        menuButtonRef.current?.contains(event.target)
      ) {
        return;
      }
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [menuOpen]);

  const toggle = () => {
    setExpanded((value) => !value);
    if (files === null) {
      void desktopApi
        .prFiles(projectId, pr.number)
        .then(setFiles)
        .catch(() => setFiles([]));
    }
  };

  const fileDiffTab = (file: PullRequestFile): WorkspaceTab => ({
    kind: "diff",
    name: `PR #${pr.number} · ${file.path}`,
    label: `PR #${pr.number} · ${file.path.split("/").at(-1) ?? file.path}`,
    detail: file.path,
    projectId,
    source: {
      type: "pr",
      prNumber: pr.number,
      filePath: file.path,
      patch: file.patch,
      status: file.status,
    },
  });

  return (
    <li>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: right-click mirrors the row's ⋯ button, which stays keyboard-reachable */}
      <div
        className="group relative flex h-7 items-center rounded-md transition-colors duration-150 hover:bg-bg-overlay/60"
        onContextMenu={(event) => {
          event.preventDefault();
          setMenuAt({ x: event.clientX, y: event.clientY });
          setMenuOpen(true);
        }}
      >
        <ShortcutHint label={`${pr.author} · ${pr.head} → ${pr.base}`}>
          <button
            type="button"
            onClick={toggle}
            className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 text-left text-[13px] text-fg-muted hover:text-fg"
            aria-expanded={expanded}
          >
            <ChevronRight
              className={`size-3 shrink-0 text-fg-faint transition-transform duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
                expanded ? "rotate-90" : ""
              }`}
            />
            <GitPullRequest className="size-3.5 shrink-0 text-fg-faint" />
            <span className="truncate">
              #{pr.number} {pr.title}
            </span>
          </button>
        </ShortcutHint>
        <button
          ref={menuButtonRef}
          type="button"
          onClick={() => {
            if (menuOpen) {
              setMenuOpen(false);
              return;
            }
            const rect = menuButtonRef.current?.getBoundingClientRect();
            if (rect) {
              setMenuAt({ x: rect.right, y: rect.bottom + 4 });
              setMenuOpen(true);
            }
          }}
          className={`mr-1 grid size-6 shrink-0 cursor-pointer place-items-center rounded text-fg-faint transition-colors duration-150 hover:text-fg ${
            menuOpen ? "" : "opacity-0 group-hover:opacity-100"
          }`}
          aria-label={`More actions for #${pr.number}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <MoreHorizontal className="size-3.5" />
        </button>
        {menuAt && (
          <MenuPortal
            open={menuOpen}
            position={menuAt}
            entries={PR_MENU}
            onPick={() => {
              setMenuOpen(false);
              onOpenUrl(pr.url, "tab");
            }}
            onExited={() => setMenuAt(null)}
          />
        )}
      </div>
      {expanded && (
        <ul className="ml-5 flex flex-col gap-0.5">
          {files === null ? (
            <li className="px-2 py-1 text-xs text-fg-faint">Loading…</li>
          ) : files.length === 0 ? (
            <li className="px-2 py-1 text-xs text-fg-faint">No files.</li>
          ) : (
            files.map((file) => {
              const badge = statusBadge(file.status);
              const separator = file.path.lastIndexOf("/");
              const dir =
                separator >= 0 ? file.path.slice(0, separator + 1) : "";
              const base =
                separator >= 0 ? file.path.slice(separator + 1) : file.path;
              return (
                <li key={file.path}>
                  <button
                    type="button"
                    onClick={() => onOpenDiff(fileDiffTab(file))}
                    className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left font-mono text-xs transition-colors duration-150 hover:bg-bg-overlay/60"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {dir && <span className="text-fg-faint">{dir}</span>}
                      <span className="text-fg">{base}</span>
                    </span>
                    <span
                      className={`shrink-0 text-[11px] font-semibold ${badge.className}`}
                    >
                      {badge.letter}
                    </span>
                    <span className="shrink-0 text-[11px] text-fg-muted">
                      +{file.additions} −{file.deletions}
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      )}
    </li>
  );
}
