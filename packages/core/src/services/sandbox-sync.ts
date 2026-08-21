import type { ProjectManager } from "@catamorphic/git";
import type { SandboxProvider } from "@catamorphic/sandbox";
import type { Identity } from "../identity.js";

/** A file the agent changed in its sandbox, mirrored into the dev tree. */
export interface SyncedFileChange {
  path: string;
  kind: "modified" | "deleted";
}

/** Files the agent stages for its own use — never synced back to the repo. */
const SYNC_IGNORED_PREFIXES = ["_plugins/", "node_modules/", ".git/"];

/**
 * Diff a sandbox project dir against its git baseline and mirror every
 * change into the user's dev working copy (as an uncommitted draft). The
 * sandbox baseline is then advanced so the next sync diffs incrementally.
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
    "git status --porcelain --untracked-files=all",
    { cwd: dir },
  );
  if (status.exitCode !== 0) return [];

  const changes = parsePorcelain(status.result).filter(
    (change) =>
      !SYNC_IGNORED_PREFIXES.some((prefix) => change.path.startsWith(prefix)),
  );
  if (changes.length === 0) return [];

  const repo = await opts.projectManager.openDev(
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

  // Advance the sandbox baseline so subsequent syncs report only new changes.
  await opts.provider.executeCommand(
    opts.sandboxProviderId,
    "git add -A && (git -c user.name=catamorphic -c user.email=agent@catamorphic.dev commit -m sync --quiet || true)",
    { cwd: dir },
  );

  return changes;
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
