import {
  type DraftChange,
  OriginDraftRepo,
  type ProjectManager,
} from "@catamorphic/git";
import type { SandboxProvider } from "@catamorphic/sandbox";
import { PROJECT_NODE_MODULES_DIR } from "@catamorphic/workflow/project-layout";
import type { Identity } from "../identity.js";

/** A file the agent changed in its sandbox, mirrored into the dev tree. */
export interface SyncedFileChange {
  path: string;
  kind: "modified" | "deleted";
}

/**
 * The sandbox's changes could not be read. Nothing was copied, so callers
 * that would destroy the sandbox next must keep it.
 */
export class SandboxSyncError extends Error {
  constructor(detail: string) {
    super(`The workspace's changes could not be saved: ${detail}`);
    this.name = "SandboxSyncError";
  }
}

/** Files the agent stages for its own use — never synced back to the repo. */
const SYNC_IGNORED_PREFIXES = [
  "_plugins/",
  "node_modules/",
  ".git/",
  `${PROJECT_NODE_MODULES_DIR}/`,
];

/**
 * Diff a sandbox project dir against what was last synced (`refs/work/synced`,
 * else HEAD) and mirror every change into the dev or session copy (as an
 * uncommitted draft). Commits the agent made count like any other change:
 * the snapshot compares trees, not the agent's status. Throws
 * {@link SandboxSyncError} when the sandbox's changes cannot be read.
 *
 * Shared by the per-turn sync in AgentSessionsService and the pre-build
 * sync in AppsService — anything that needs the dev tree to reflect what
 * the agent has actually done right now.
 */
export async function syncSandboxChanges(opts: {
  provider: SandboxProvider;
  projectManager: ProjectManager;
  identity: Identity;
  projectId: string;
  sessionId?: string;
  sandboxProviderId: string;
  /** The sandbox path holding the project checkout. */
  projectDir: string;
}): Promise<SyncedFileChange[]> {
  const dir = opts.projectDir;
  // cwd via ExecOpts, not `cd`: virtual sandbox paths (/workspace/...) are
  // only real inside providers with a mounted root — local-process (ADR
  // 0047) maps them per-argument, so a cd embedded in the command string
  // would resolve against the host filesystem.
  const status = await opts.provider.executeCommand(
    opts.sandboxProviderId,
    SNAPSHOT_SCRIPT,
    { cwd: dir },
  );
  if (status.exitCode !== 0)
    throw new SandboxSyncError(
      status.result.trim().split("\n").slice(-3).join(" ") ||
        `snapshot exited with ${status.exitCode}`,
    );
  const snapshot = parseSnapshot(status.result);
  if (!snapshot) throw new SandboxSyncError("the snapshot was unreadable");

  const changes = snapshot.changes.filter(
    (change) =>
      !SYNC_IGNORED_PREFIXES.some((prefix) => change.path.startsWith(prefix)),
  );
  if (changes.length > 0) {
    const repo = opts.sessionId
      ? await opts.projectManager.openSession({
          tenantId: opts.identity.tenantId,
          projectId: opts.projectId,
          sessionId: opts.sessionId,
        })
      : await opts.projectManager.openDraft({
          tenantId: opts.identity.tenantId,
          projectId: opts.projectId,
          externalUserId: opts.identity.externalUserId,
        });
    try {
      if (repo instanceof OriginDraftRepo) {
        // One draft commit for the whole sync (ADR 0191). A file the
        // agent made and removed again, or one the project ignores, is
        // judged inside the compare-and-swap, not from an earlier read.
        const draftChanges: DraftChange[] = [];
        for (const change of changes) {
          if (change.kind === "deleted") {
            draftChanges.push({ path: change.path, delete: true });
          } else {
            draftChanges.push({
              path: change.path,
              content: await opts.provider.downloadFile(
                opts.sandboxProviderId,
                `${dir}/${change.path}`,
              ),
            });
          }
        }
        await repo.write({
          changes: draftChanges,
          message: "Agent changes",
          skipMissingDeletes: true,
          skipIgnored: true,
        });
      } else {
        for (const change of changes) {
          if (change.kind === "deleted") {
            await repo.deleteFile(change.path).catch(() => {});
          } else {
            const content = await opts.provider.downloadFile(
              opts.sandboxProviderId,
              `${dir}/${change.path}`,
            );
            await repo.writeFile(change.path, content);
          }
        }
      }
    } finally {
      await repo.dispose();
    }
  }

  // Mark what was copied so the next sync reports only new changes. The
  // agent's branch, index, and commits are untouched.
  if (snapshot.changes.length > 0)
    await opts.provider.executeCommand(
      opts.sandboxProviderId,
      `commit=$(git -c 'user.name=Work Agent' -c user.email=agent@work.software commit-tree ${snapshot.tree} -m synced) && git update-ref refs/work/synced "$commit"`,
      { cwd: dir },
    );

  return changes;
}

/**
 * Snapshot the working tree (tracked and untracked, honoring ignores) into
 * a private index, then list what differs from the last synced tree. The
 * first line is the snapshot's tree id; name-status pairs follow, NUL
 * separated.
 */
const SNAPSHOT_SCRIPT = [
  "git_dir=$(git rev-parse --git-dir)",
  'export GIT_INDEX_FILE="$git_dir/work-sync-index"',
  'if [ ! -f "$GIT_INDEX_FILE" ] && [ -f "$git_dir/index" ]; then cp "$git_dir/index" "$GIT_INDEX_FILE"; fi',
  'base=$(git rev-parse -q --verify "refs/work/synced^{tree}" || git rev-parse -q --verify "HEAD^{tree}" || git hash-object -t tree /dev/null)',
  "git add -A",
  "tree=$(git write-tree)",
  'printf "%s\\n" "$tree"',
  // Not -z: remote workers carry output as JSON text, and Postgres JSON
  // cannot hold NUL. Unusual paths come back C-quoted instead.
  'git -c core.quotePath=false diff-tree -r --no-renames --name-status "$base" "$tree"',
].join(" && ");

/** Parse {@link SNAPSHOT_SCRIPT}'s output. */
export function parseSnapshot(
  output: string,
): { tree: string; changes: SyncedFileChange[] } | null {
  const [first, ...lines] = output.split("\n");
  const tree = first?.trim() ?? "";
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(tree)) return null;
  const changes = lines.flatMap((line): SyncedFileChange[] => {
    const tab = line.indexOf("\t");
    if (tab < 0) return [];
    const status = line.slice(0, tab).trim();
    const path = unquoteCPath(line.slice(tab + 1));
    return status && path
      ? [{ path, kind: status.startsWith("D") ? "deleted" : "modified" }]
      : [];
  });
  return { tree, changes };
}

/** Git's C-style quoting of unusual paths (`"a\tb"`, octal UTF-8 bytes). */
export function unquoteCPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const body = value.slice(1, -1);
  const bytes: number[] = [];
  const escapes: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    "\\": 92,
  };
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? "";
    if (char !== "\\") {
      bytes.push(...new TextEncoder().encode(char));
      continue;
    }
    const next = body[index + 1] ?? "";
    if (/[0-7]/.test(next)) {
      bytes.push(Number.parseInt(body.slice(index + 1, index + 4), 8));
      index += 3;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      index += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

interface PorcelainChange {
  path: string;
  kind: "modified" | "deleted";
}

/**
 * Parse `git status --porcelain` output into changed paths. Renames
 * (`R  old -> new`) count as a delete of `old` + modify of `new`.
 */
export function parsePorcelain(output: string): PorcelainChange[] {
  const changes: PorcelainChange[] = [];
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) continue;
    const code = line.slice(0, 2);
    const rest = line.slice(3);
    if (code.includes("R")) {
      const [from, to] = rest.split(" -> ");
      if (from) changes.push({ path: unquotePath(from), kind: "deleted" });
      if (to) changes.push({ path: unquotePath(to), kind: "modified" });
      continue;
    }
    const path = unquotePath(rest);
    if (!path) continue;
    // Without `--untracked-files=all` git reports untracked directories as a
    // single `?? dir/` entry — never a real file, so skip defensively.
    if (path.endsWith("/")) continue;
    changes.push({
      path,
      kind: code.includes("D") ? "deleted" : "modified",
    });
  }
  return changes;
}

function unquotePath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
