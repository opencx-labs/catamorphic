import type { ProjectManager } from "@catamorphic/git";
import type { SandboxProvider } from "@catamorphic/sandbox";
import { PROJECT_NODE_MODULES_DIR } from "@catamorphic/workflow/project-layout";
import type { Identity } from "../identity.js";

/** A file the agent changed in its sandbox, mirrored into the dev tree. */
export interface SyncedFileChange {
  path: string;
  kind: "modified" | "deleted";
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
 * the snapshot compares trees, not the agent's status.
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
  if (status.exitCode !== 0) return [];
  const snapshot = parseSnapshot(status.result);
  if (!snapshot) return [];

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
      : await opts.projectManager.openDev(
          opts.identity.tenantId,
          opts.projectId,
          opts.identity.externalUserId,
        );
    try {
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
  'git diff-tree -r -z --no-renames --name-status "$base" "$tree"',
].join(" && ");

/** Parse {@link SNAPSHOT_SCRIPT}'s output. */
export function parseSnapshot(
  output: string,
): { tree: string; changes: SyncedFileChange[] } | null {
  const newline = output.indexOf("\n");
  const tree = output.slice(0, newline).trim();
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(tree)) return null;
  const fields = output.slice(newline + 1).split("\0");
  const changes: SyncedFileChange[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index]?.trim();
    const path = fields[index + 1];
    if (!status || !path) continue;
    changes.push({
      path,
      kind: status.startsWith("D") ? "deleted" : "modified",
    });
  }
  return { tree, changes };
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
