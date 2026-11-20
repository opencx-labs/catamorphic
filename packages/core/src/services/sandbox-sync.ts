import {
  NativeProjectRepo,
  OriginDraftRepo,
  type ProjectManager,
  ReceivedPack,
  type SavedChange,
  savedDraftChanges,
  shellQuote,
  WorkspaceSaveError,
  writeSavedChanges,
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
 * The sandbox's changes could not be read, or were refused. They are not
 * marked as saved, so callers that would destroy the sandbox next must
 * keep it.
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
 * Base64 characters of the pack one remote operation carries (ADR 0341):
 * a multiple of four, so each chunk decodes alone, and a quarter of the
 * 16 MiB of output a provider keeps from one command.
 */
const CHUNK_CHARACTERS = 4 * 1024 * 1024;
/** The largest pack one save carries: 2 GiB of base64, 1.5 GiB of pack. */
const MAX_CHUNKS = 512;
/** The most a save writes into a checkout on this machine, unpacked. */
const MAX_CHECKOUT_BYTES = 4 * 1024 * 1024 * 1024;
/** The most a save writes into a draft, which holds it in memory. */
const MAX_DRAFT_BYTES = 256 * 1024 * 1024;
/** Seconds a snapshot or a chunk may take in the sandbox. */
const SAVE_TIMEOUT_SECONDS = 600;

/** Where the sandbox keeps the pack between the operations of one save. */
const PACK_FILE = '"$(git rev-parse --git-dir)/work-sync/pack.b64"';

/**
 * Diff a sandbox project dir against what was last synced (`refs/work/synced`,
 * else HEAD) and mirror every change into the dev or session copy (as an
 * uncommitted draft), exactly: bytes, executable bits, links and deletions
 * (ADR 0341). Commits the agent made count like any other change: the
 * snapshot compares trees, not the agent's status. Throws
 * {@link SandboxSyncError} when the sandbox's changes cannot be read or
 * name something a save may not write.
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
  const save = await readSandboxSave(opts);
  if (!save.pack) return [];
  const { pack } = save;
  const changes = save.changes.filter(
    (change) =>
      !SYNC_IGNORED_PREFIXES.some((prefix) => change.path.startsWith(prefix)),
  );
  try {
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
        await pack.assertBlobs({
          oids: changes.flatMap((change) =>
            change.kind === "deleted" ? [] : [change.oid],
          ),
          maxBytes:
            repo instanceof OriginDraftRepo
              ? MAX_DRAFT_BYTES
              : MAX_CHECKOUT_BYTES,
        });
        if (repo instanceof OriginDraftRepo) {
          // One draft commit for the whole sync (ADR 0191). A file the
          // agent made and removed again, or one the project ignores, is
          // judged inside the compare-and-swap, not from an earlier read.
          await repo.write({
            changes: await savedDraftChanges({ changes, pack }),
            message: "Agent changes",
            skipMissingDeletes: true,
            skipIgnored: true,
            replaceLinks: true,
          });
        } else {
          await writeSavedChanges({
            repoPath: repo.repoPath,
            changes,
            pack,
            // A person's own folder follows links; a copy Work manages
            // never does, so it keeps every link as it was.
            containLinks: repo instanceof NativeProjectRepo,
          });
        }
      } finally {
        await repo.dispose();
      }
    }
  } catch (error) {
    throw asSyncError(error);
  } finally {
    await pack.dispose();
  }

  // Mark what was copied so the next sync reports only new changes. The
  // agent's branch, index, and commits are untouched.
  await opts.provider.executeCommand(
    opts.sandboxProviderId,
    `commit=$(git -c 'user.name=Work Agent' -c user.email=agent@work.software commit-tree ${save.tree} -m synced) && git update-ref refs/work/synced "$commit"; rm -rf "$(git rev-parse --git-dir)/work-sync"`,
    { cwd: opts.projectDir },
  );

  return changes.map((change) => ({
    path: change.path,
    kind: change.kind === "deleted" ? "deleted" : "modified",
  }));
}

function asSyncError(error: unknown): unknown {
  return error instanceof WorkspaceSaveError
    ? new SandboxSyncError(error.message)
    : error;
}

/**
 * Snapshot the working tree (tracked and untracked, honoring ignores) into
 * a private index, then pack what differs from the last synced tree: the
 * blob of every changed file, and a manifest of the changes as a blob of
 * its own. The pack waits in the Git directory as base64, which is all a
 * provider's command output carries safely (remote workers send it as JSON
 * text, and Postgres JSON cannot hold NUL). The output's `work-sync` line
 * names the snapshot's tree, the manifest and the pack's length; its
 * `chunk` line is the pack's first chunk.
 */
const SNAPSHOT_SCRIPT = [
  "set -e",
  "git_dir=$(git rev-parse --git-dir)",
  'export GIT_INDEX_FILE="$git_dir/work-sync-index"',
  'if [ ! -f "$GIT_INDEX_FILE" ] && [ -f "$git_dir/index" ]; then cp "$git_dir/index" "$GIT_INDEX_FILE"; fi',
  'base=$(git rev-parse -q --verify "refs/work/synced^{tree}" || git rev-parse -q --verify "HEAD^{tree}" || git hash-object -t tree /dev/null)',
  "git add -A",
  "tree=$(git write-tree)",
  'out="$git_dir/work-sync"',
  'rm -rf "$out"',
  'mkdir -p "$out"',
  // The manifest: NUL-separated, so every path arrives as its own bytes.
  'git diff-tree -r --no-renames --raw --no-abbrev -z "$base" "$tree" > "$out/changes"',
  'if [ ! -s "$out/changes" ]; then rm -rf "$out"; printf \'work-sync\\t%s\\t-\\t0\\n\' "$tree"; exit 0; fi',
  // The blobs to pack: files and links, never a nested repository's commit
  // and nothing under a folder that is never saved.
  "tab=$(printf '\\t')",
  'git -c core.quotePath=false diff-tree -r --no-renames --raw --no-abbrev "$base" "$tree" | while IFS= read -r line; do',
  `  meta=\${line%%"$tab"*}`,
  `  name=\${line#*"$tab"}`,
  `  case "$name" in ${SYNC_IGNORED_PREFIXES.flatMap((prefix) => [
    `${shellQuote(prefix)}*`,
    `${shellQuote(`"${prefix}`)}*`,
  ]).join("|")}) continue;; esac`,
  "  set -- $meta",
  '  case "$2" in 100644|100755|120000) printf \'%s\\n\' "$4";; esac',
  'done > "$out/oids"',
  'manifest=$(git hash-object -w --no-filters "$out/changes")',
  'printf \'%s\\n\' "$manifest" >> "$out/oids"',
  // Self-contained, so the receiver needs no object of its own.
  'git pack-objects --stdout -q < "$out/oids" > "$out/pack"',
  'base64 < "$out/pack" | tr -d \'\\n\' > "$out/pack.b64"',
  'rm -f "$out/pack" "$out/oids" "$out/changes"',
  "size=$(wc -c < \"$out/pack.b64\" | tr -d ' ')",
  'printf \'work-sync\\t%s\\t%s\\t%s\\n\' "$tree" "$manifest" "$size"',
  "printf 'chunk\\t'",
  `head -c ${CHUNK_CHARACTERS} "$out/pack.b64"`,
  "printf '\\n'",
].join("\n");

/** The rest of the first output line that starts with `tag` and a tab. */
function taggedLine(output: string, tag: string): string | null {
  const marker = `${tag}\t`;
  const start = output.startsWith(marker)
    ? 0
    : output.indexOf(`\n${marker}`) + 1;
  if (start === 0 && !output.startsWith(marker)) return null;
  const end = output.indexOf("\n", start);
  return output.slice(start + marker.length, end < 0 ? undefined : end);
}

/** One chunk of the pack: exactly `length` base64 characters, or refused. */
function decodeChunk(output: string, length: number): Uint8Array {
  const text = taggedLine(output, "chunk")?.replace(/\r$/, "");
  if (
    text === undefined ||
    text.length !== length ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(text)
  )
    throw new SandboxSyncError("part of the workspace's files was cut short");
  return Buffer.from(text, "base64");
}

/**
 * A sandbox's changes since its last save, read and checked but not yet
 * written anywhere (ADR 0341): the snapshot's tree, every change, and the
 * pack holding their contents. `pack` is null when nothing changed;
 * otherwise the caller disposes it.
 */
export async function readSandboxSave(opts: {
  provider: SandboxProvider;
  sandboxProviderId: string;
  /** The sandbox path holding the project checkout. */
  projectDir: string;
}): Promise<{
  tree: string;
  changes: SavedChange[];
  pack: ReceivedPack | null;
}> {
  // cwd via ExecOpts, not `cd`: virtual sandbox paths (/workspace/...) are
  // only real inside providers with a mounted root — local-process (ADR
  // 0047) maps them per-argument, so a cd embedded in the command string
  // would resolve against the host filesystem.
  const exec = { cwd: opts.projectDir, timeout: SAVE_TIMEOUT_SECONDS };
  const status = await opts.provider.executeCommand(
    opts.sandboxProviderId,
    SNAPSHOT_SCRIPT,
    exec,
  );
  if (status.exitCode !== 0)
    throw new SandboxSyncError(
      status.result.trim().split("\n").slice(-3).join(" ").slice(-600) ||
        `snapshot exited with ${status.exitCode}`,
    );
  const [tree = "", manifest = "", length = ""] = (
    taggedLine(status.result, "work-sync") ?? ""
  )
    .trim()
    .split("\t");
  const objectId = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
  if (!objectId.test(tree) || !/^\d{1,12}$/.test(length))
    throw new SandboxSyncError("the snapshot was unreadable");
  const size = Number(length);
  if (manifest === "-" && size === 0) return { tree, changes: [], pack: null };
  if (
    !objectId.test(manifest) ||
    manifest.length !== tree.length ||
    size === 0 ||
    size % 4 !== 0
  )
    throw new SandboxSyncError("the snapshot was unreadable");
  if (size > CHUNK_CHARACTERS * MAX_CHUNKS)
    throw new SandboxSyncError(
      `the workspace changed more than ${Math.floor((CHUNK_CHARACTERS * MAX_CHUNKS * 3) / 4 / (1024 * 1024))} MiB at once`,
    );
  const { provider, sandboxProviderId } = opts;
  async function* chunks(): AsyncGenerator<Uint8Array> {
    yield decodeChunk(status.result, Math.min(size, CHUNK_CHARACTERS));
    for (
      let offset = CHUNK_CHARACTERS;
      offset < size;
      offset += CHUNK_CHARACTERS
    ) {
      const next = await provider.executeCommand(
        sandboxProviderId,
        `printf 'chunk\\t'; tail -c +${offset + 1} ${PACK_FILE} 2>/dev/null | head -c ${CHUNK_CHARACTERS}; printf '\\n'`,
        exec,
      );
      if (next.exitCode !== 0)
        throw new SandboxSyncError("the workspace's files could not be read");
      yield decodeChunk(next.result, Math.min(CHUNK_CHARACTERS, size - offset));
    }
  }
  try {
    const pack = await ReceivedPack.receive({
      objectFormat: tree.length === 64 ? "sha256" : "sha1",
      chunks: chunks(),
    });
    try {
      return { tree, changes: await pack.changes({ manifest }), pack };
    } catch (error) {
      await pack.dispose();
      throw error;
    }
  } catch (error) {
    throw asSyncError(error);
  }
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
