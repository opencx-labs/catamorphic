import type { GitChangedFile, GitDiffMode } from "../../shared/git.js";
import { openModeForAction } from "../../shared/open-mode.js";
import type { SidebarSourceItem } from "../../shared/sidebar-source.js";
import { desktopApi } from "../lib/desktop-api.js";
import {
  capabilitiesOf,
  invalidateBranches,
  type SectionSource,
} from "./contract.js";
import type { WorkSourceDeps } from "./deps.js";

const isOpen = (action: string) =>
  action === "open" || Boolean(openModeForAction(action));

/**
 * `work:git`: the project's checkouts (its folder and its worktrees), each
 * holding the files changed in it. A file row opens its diff. Beside a chat
 * (`when.session`), that chat's checkout comes first.
 */
export function gitSource(deps: WorkSourceDeps): SectionSource {
  /** Where each change row's diff lives, by row id. */
  const diffs = new Map<
    string,
    {
      worktreePath: string;
      filePath: string;
      mode: GitDiffMode;
      previousPath?: string;
      baseRef?: string;
    }
  >();
  /** Untracked folders git names whole, by row id: opened, their files. */
  const folders = new Map<
    string,
    { worktreePath: string; directory: string }
  >();
  const fileRow = (
    worktreePath: string,
    checkout: string,
    file: GitChangedFile,
    baseRef?: string,
  ): SidebarSourceItem => {
    const id = `${worktreePath}:${file.mode}:${file.path}`;
    // Git lists a new folder as one entry; it opens into its files.
    if (file.mode === "untracked" && file.path.endsWith("/")) {
      folders.set(id, { worktreePath, directory: file.path });
      return {
        id,
        parentId: worktreePath,
        hasChildren: true,
        label: file.path,
        icon: "Folder",
        badges: [file.mode],
        data: { path: file.path, mode: file.mode, checkout },
      };
    }
    diffs.set(id, {
      worktreePath,
      filePath: file.path,
      mode: file.mode,
      previousPath: file.previousPath,
      baseRef,
    });
    return {
      id,
      parentId: worktreePath,
      label: file.path,
      icon: "FileDiff",
      badges: [file.kind, file.mode],
      data: { path: file.path, kind: file.kind, mode: file.mode, checkout },
    };
  };
  const source: SectionSource = {
    title: "Changes",
    empty: "No changes.",
    capabilities: () => capabilitiesOf(source),
    load: async ({ parentId, session }) => {
      if (!deps.writesProgram)
        throw new Error("Changes are for people who edit this project.");
      const folder = parentId ? folders.get(parentId) : undefined;
      if (parentId && folder) {
        const listed = await desktopApi.gitUntrackedDirectory({
          projectId: deps.projectId,
          worktreePath: folder.worktreePath,
          directory: folder.directory,
        });
        return {
          items: [
            ...listed.files.map((file) => ({
              ...fileRow(folder.worktreePath, folder.worktreePath, file),
              parentId,
            })),
            ...(listed.truncated
              ? [
                  {
                    id: `${parentId}:more`,
                    parentId,
                    label: "The first 2,000 files; find others with Find files",
                    icon: "Info",
                  },
                ]
              : []),
          ],
        };
      }
      const overview = await desktopApi.gitOverview(
        deps.projectId,
        parentId ? [parentId] : [],
        session?.id,
      );
      if (overview.error) throw new Error(overview.error);
      if (!parentId)
        return {
          items: overview.worktrees.map(
            (tree): SidebarSourceItem => ({
              id: tree.path,
              label: tree.branch ?? tree.path,
              description: tree.path,
              icon: "GitBranch",
              hasChildren: true,
              data: { path: tree.path, branch: tree.branch ?? null },
            }),
          ),
        };
      const tree = overview.worktrees.find((entry) => entry.path === parentId);
      if (tree?.error) throw new Error(tree.error);
      return {
        items: [...(tree?.changes ?? []), ...(tree?.branchChanges ?? [])].map(
          (file) =>
            fileRow(parentId, tree?.branch ?? parentId, file, tree?.baseRef),
        ),
      };
    },
    // The observed overview (ADR 0149): scoped watches, coalesced, released
    // with the view. A snapshot that changed reads the loaded rows again.
    subscribe: (publish, { branches, session }) => {
      if (!deps.writesProgram) return () => {};
      let last: string | undefined;
      return desktopApi.watchGitOverview(
        { projectId: deps.projectId, paths: "all", sessionId: session?.id },
        (snapshot) => {
          const next = JSON.stringify(snapshot);
          if (last !== undefined && next !== last)
            invalidateBranches(publish, branches(), { quiet: true });
          last = next;
        },
      );
    },
    action: async ({ itemId, action }) => {
      // A notice row opens nothing.
      if (itemId.endsWith(":more") && isOpen(action)) return undefined;
      const diff = diffs.get(itemId);
      if (!diff || !isOpen(action))
        throw new Error("This change does not support that action");
      deps.host().openTab(
        {
          kind: "diff",
          name: itemId,
          projectId: deps.projectId,
          source: {
            type: "local",
            worktreePath: diff.worktreePath,
            filePath: diff.filePath,
            mode: diff.mode,
            previousPath: diff.previousPath,
            baseRef: diff.baseRef,
          },
        },
        openModeForAction(action),
      );
      return undefined;
    },
  };
  return source;
}

/** How long an open list of pull requests stays before it is read again. */
const PRS_REFRESH_MS = 60_000;

/**
 * `work:prs`: the project's open pull requests through the GitHub CLI, or
 * a connected project's proposals through its server. A row opens its
 * review; with the CLI off, one row offers to connect it.
 */
export function prsSource(deps: WorkSourceDeps): SectionSource {
  const source: SectionSource = {
    title: "Proposals",
    empty: "No open pull requests.",
    capabilities: () => capabilitiesOf(source),
    load: async ({ parentId }) => {
      if (parentId) return { items: [] };
      try {
        const prs = await desktopApi.prList(deps.projectId);
        return {
          items: prs.map((pr) => ({
            id: String(pr.number),
            label: pr.title,
            description: `#${pr.number}`,
            icon: "GitPullRequest",
            ...(pr.draft ? { badges: ["Draft"] } : {}),
            preview: {
              title: pr.title,
              metadata: [
                { label: "Author", value: pr.author },
                { label: "Branch", value: `${pr.head} → ${pr.base}` },
              ],
            },
            menu: [
              {
                label: "Open on the web",
                action: "open",
                icon: "Globe",
                url: pr.url,
              },
            ],
            data: {
              number: pr.number,
              author: pr.author,
              title: pr.title,
              url: pr.url,
            },
          })),
        };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const signedOut = message.includes("[github-cli-required]");
        if (!signedOut && !message.includes("[github-cli-disabled]"))
          throw cause;
        return {
          items: [
            {
              id: "connect-github",
              label: signedOut
                ? "Sign in to the GitHub CLI to review pull requests"
                : "Connect the GitHub CLI to review pull requests",
              icon: "GitPullRequest",
              signal: "attention",
            },
          ],
        };
      }
    },
    subscribe: (publish) => {
      const refresh = () => publish({ type: "invalidate", quiet: true });
      const timer = setInterval(() => {
        if (!document.hidden) refresh();
      }, PRS_REFRESH_MS);
      window.addEventListener("focus", refresh);
      return () => {
        clearInterval(timer);
        window.removeEventListener("focus", refresh);
      };
    },
    action: async ({ itemId, action }) => {
      if (!isOpen(action))
        throw new Error("This pull request does not support that action");
      const mode = openModeForAction(action);
      if (itemId === "connect-github") {
        deps.host().openTab(
          {
            kind: "settings",
            name: "settings",
            label: "Settings",
            destination: { id: "github-cli", requestId: crypto.randomUUID() },
          },
          mode,
        );
        return undefined;
      }
      const number = Number(itemId);
      if (!Number.isSafeInteger(number))
        throw new Error("This pull request is gone.");
      deps.host().openTab(
        {
          kind: "diff",
          name: `review:${number}`,
          projectId: deps.projectId,
          source: { type: "review", prNumber: number },
        },
        mode,
      );
      return undefined;
    },
  };
  return source;
}
