import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkspaceSetupOutcome } from "@catamorphic/core";
import { ensurePersonalFilesExcluded, hasLocalGit } from "@catamorphic/git";
import {
  AGENT_COMMIT_AUTHOR,
  MANAGED_BRANCH_PREFIX,
  PROJECT_PERSONAL_DIR,
} from "@catamorphic/workflow/project-layout";
import type { PGlite } from "@electric-sql/pglite";
import { runNativeWorkspaceSetup } from "./native-workspace-setup.js";

const execFileAsync = promisify(execFile);

export type SessionCheckoutKind = "primary" | "managed" | "external";

export interface SessionCheckoutBinding {
  sessionId: string;
  projectId: string;
  path: string;
  kind: Exclude<SessionCheckoutKind, "primary">;
  /** A chat's own worktree has none until its first checkout (ADR 0215). */
  branch: string | null;
}

export interface SessionCheckoutDescription {
  path: string;
  kind: SessionCheckoutKind;
  branch: string | null;
  /**
   * The folder exists now. A chat's own worktree is absent before its
   * first turn and while the chat is put away; its next turn checks it
   * out (ADR 0215).
   */
  present: boolean;
}

/** What the chat's status popup shows about where the chat works. */
export interface SessionCheckoutDetail extends SessionCheckoutDescription {
  projectFolder: string;
  /** The project is a Git repository with a commit to start a worktree at. */
  worktreesAvailable: boolean;
  /**
   * Files a chat's own worktree changed since it left the project folder's
   * history, recorded or not; null for other checkouts.
   */
  changedFiles: number | null;
}

export interface RepositoryWorktree {
  path: string;
  branch: string | null;
  detached: boolean;
}

export interface ClassifiedRepositoryWorktree extends RepositoryWorktree {
  kind: SessionCheckoutKind;
}

interface SessionCheckoutsOptions {
  pglite: PGlite;
  worktreesDirectory: string;
  projectRoot: (projectId: string) => string | undefined;
}

/** Ignored files a new worktree copies from the project folder (ADR 0215). */
export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

const repositoryMutationLocks = new Map<string, Promise<void>>();

async function git(cwd: string, args: string[]): Promise<string> {
  return (
    await execFileAsync("git", ["-C", cwd, ...args], {
      maxBuffer: 64 * 1024 * 1024,
    })
  ).stdout;
}

async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

/** Run git for its exit code too, feeding `input` on stdin. */
function gitRun(
  cwd: string,
  args: string[],
  input?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
    child.stdin.end(input ?? "");
  });
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(
    () => true,
    () => false,
  );
}

async function canonicalCommonDir(cwd: string): Promise<string> {
  const raw = (await git(cwd, ["rev-parse", "--git-common-dir"])).trim();
  return fs.realpath(path.isAbsolute(raw) ? raw : path.resolve(cwd, raw));
}

async function canonicalPath(filePath: string): Promise<string> {
  return fs.realpath(path.resolve(filePath));
}

function nulSeparated(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

/** Paths `git status --porcelain=v1 -z` reports, both sides of a rename. */
function statusPaths(output: string): string[] {
  const fields = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field || field.length < 4) continue;
    paths.push(field.slice(3));
    // A rename or copy names its source in the next field.
    if (field[0] === "R" || field[0] === "C") {
      const source = fields[index + 1];
      if (source) paths.push(source);
      index++;
    }
  }
  return paths;
}

async function holdsFiles(directory: string): Promise<boolean> {
  const entries = await fs
    .readdir(directory, { recursive: true, withFileTypes: true })
    .catch(() => []);
  return entries.some((entry) => !entry.isDirectory());
}

async function withRepositoryMutationLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = repositoryMutationLocks.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  repositoryMutationLocks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (repositoryMutationLocks.get(key) === queued) {
      repositoryMutationLocks.delete(key);
    }
  }
}

/** Parse `git worktree list --porcelain -z` without breaking spaced paths. */
export function parseWorktreePorcelain(output: string): RepositoryWorktree[] {
  const records = output.split("\0\0");
  const worktrees: RepositoryWorktree[] = [];
  for (const record of records) {
    if (!record) continue;
    const fields = record.split("\0").filter(Boolean);
    const worktree = fields.find((field) => field.startsWith("worktree "));
    if (!worktree) continue;
    const branch = fields.find((field) => field.startsWith("branch "));
    worktrees.push({
      path: worktree.slice("worktree ".length),
      branch: branch
        ? branch.slice("branch ".length).replace(/^refs\/heads\//, "")
        : null,
      detached: fields.includes("detached"),
    });
  }
  return worktrees;
}

/**
 * Desktop-local session checkout assignments. A missing assignment always
 * means the project's primary folder. A chat's own (managed) worktree is
 * chosen by the person or created by an agent; its folder exists only
 * while the chat needs it (ADR 0215).
 */
export class SessionCheckouts {
  private readonly pglite: PGlite;
  private readonly worktreesDirectory: string;
  private readonly projectRoot: SessionCheckoutsOptions["projectRoot"];
  /** What the next turn tells the agent once, after the person moved it. */
  private readonly notices = new Map<string, string>();

  constructor(options: SessionCheckoutsOptions) {
    this.pglite = options.pglite;
    this.worktreesDirectory = options.worktreesDirectory;
    this.projectRoot = options.projectRoot;
  }

  async init(): Promise<void> {
    await this.pglite.exec(`
      CREATE SCHEMA IF NOT EXISTS desktop;
      CREATE TABLE IF NOT EXISTS desktop.session_checkouts (
        session_id uuid PRIMARY KEY,
        project_id uuid NOT NULL,
        path text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('managed', 'external')),
        branch text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS session_checkouts_project_idx
        ON desktop.session_checkouts(project_id);
    `);
  }

  async resolve(input: {
    projectId: string;
    sessionId: string;
  }): Promise<string | undefined> {
    const root = this.projectRoot(input.projectId);
    if (!root) return undefined;
    const binding = await this.binding(input);
    if (!binding) return root;
    // The chat's own worktree comes back with its next turn.
    if (binding.kind === "managed" && !(await exists(binding.path)))
      return binding.path;
    try {
      await this.assertSameRepository(root, binding.path);
      return await canonicalPath(binding.path);
    } catch {
      throw new Error(
        `The assigned worktree at ${binding.path} is unavailable. Restore that folder or explicitly choose the project folder before continuing. Your changes have not been moved.`,
      );
    }
  }

  /**
   * The folder a native agent works in, and whether it is the chat's own.
   * A chat at a ref of the project's remote, or asked to move to one (ADR
   * 0178), always works in its own worktree, started at that commit from the
   * host's mirror. A chat's own worktree that is not checked out now is
   * checked out again (ADR 0215). Only a managed worktree is the chat's own:
   * base moves never touch the project folder or a worktree the person
   * assigned.
   */
  async resolveForAgent(input: {
    projectId: string;
    sessionId: string;
    workspace?: { repository: string; pin: string; commit: string };
    /** Whether the isolation policy keeps this chat out of `checkoutPath`. */
    requiresIsolation(checkoutPath: string): Promise<boolean>;
  }): Promise<{ path: string; owned: boolean }> {
    const current = await this.describe(input);
    if (input.workspace && current.kind === "primary") {
      const created = await this.createManaged({
        projectId: input.projectId,
        sessionId: input.sessionId,
        start: {
          repository: input.workspace.repository,
          ref: input.workspace.pin,
          commit: input.workspace.commit,
        },
      });
      return { path: created.path, owned: true };
    }
    if (current.kind === "managed" && !current.present) {
      const created = await this.createManaged({
        projectId: input.projectId,
        sessionId: input.sessionId,
      });
      return { path: created.path, owned: true };
    }
    if (await input.requiresIsolation(current.path)) {
      if (current.kind !== "primary") {
        throw new Error(
          "Isolation policy prevents sharing this assigned worktree with another running session. Choose another worktree or wait for that session to finish.",
        );
      }
      const created = await this.createManaged({
        projectId: input.projectId,
        sessionId: input.sessionId,
        ensureAvailable: async (checkoutPath) => {
          if (await input.requiresIsolation(checkoutPath)) {
            throw new Error(
              "Isolation policy prevents sharing the new worktree with another running session.",
            );
          }
        },
      });
      return { path: created.path, owned: true };
    }
    return { path: current.path, owned: current.kind === "managed" };
  }

  async describe(input: {
    projectId: string;
    sessionId: string;
  }): Promise<SessionCheckoutDescription> {
    const resolved = await this.resolve(input);
    if (!resolved)
      throw new Error(`Project '${input.projectId}' has no folder`);
    const binding = await this.binding(input);
    return binding
      ? {
          path: resolved,
          kind: binding.kind,
          branch: binding.branch,
          present: await exists(resolved),
        }
      : { path: resolved, kind: "primary", branch: null, present: true };
  }

  /** Where a chat works, for its status popup (ADR 0215). */
  async detail(input: {
    projectId: string;
    sessionId: string;
  }): Promise<SessionCheckoutDetail> {
    const root = this.requireRoot(input.projectId);
    const description = await this.describe(input);
    const worktreesAvailable = await this.worktreesAvailable(input.projectId);
    let changedFiles: number | null = null;
    if (description.kind === "managed" && description.branch) {
      changedFiles = await this.changedFiles({
        root,
        branch: description.branch,
        worktree: description.present ? description.path : null,
      }).catch(() => null);
    } else if (description.kind === "managed") {
      changedFiles = 0;
    }
    return {
      ...description,
      projectFolder: root,
      worktreesAvailable,
      changedFiles,
    };
  }

  /** The project can start a worktree: a Git repository with a commit. */
  async worktreesAvailable(projectId: string): Promise<boolean> {
    const root = this.projectRoot(projectId);
    if (!root || !(await hasLocalGit({ path: root }))) return false;
    return gitSucceeds(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  }

  async list(projectId: string): Promise<ClassifiedRepositoryWorktree[]> {
    const root = this.requireRoot(projectId);
    if (!(await hasLocalGit({ path: root }))) return [];
    const primary = await canonicalPath(root);
    const configuredManagedRoot = path.resolve(
      this.worktreesDirectory,
      projectId,
    );
    const managedRoot = await canonicalPath(configuredManagedRoot).catch(
      () => configuredManagedRoot,
    );
    const worktrees = parseWorktreePorcelain(
      await git(root, ["worktree", "list", "--porcelain", "-z"]),
    );
    return worktrees.map((worktree) => {
      const resolved = path.resolve(worktree.path);
      const kind: SessionCheckoutKind =
        resolved === primary
          ? "primary"
          : resolved.startsWith(`${managedRoot}${path.sep}`)
            ? "managed"
            : "external";
      return { ...worktree, kind };
    });
  }

  /** List retained assignments even when a folder is temporarily unavailable. */
  async assigned(projectId: string): Promise<
    Array<{
      sessionId: string;
      path: string;
      kind: "managed" | "external";
      branch: string | null;
      present: boolean;
    }>
  > {
    const result = await this.pglite.query<{
      session_id: string;
      path: string;
      kind: "managed" | "external";
      branch: string | null;
    }>(
      `SELECT session_id, path, kind, branch
       FROM desktop.session_checkouts
       WHERE project_id = $1
       ORDER BY created_at`,
      [projectId],
    );
    return Promise.all(
      result.rows.map(async (row) => ({
        sessionId: row.session_id,
        path: row.path,
        kind: row.kind,
        branch: row.branch,
        present: await exists(row.path),
      })),
    );
  }

  async isOccupied(input: {
    projectId: string;
    sessionId: string;
    path: string;
    peerSessionIds: string[];
  }): Promise<boolean> {
    const candidate = await canonicalPath(input.path).catch(() =>
      path.resolve(input.path),
    );
    for (const peerSessionId of input.peerSessionIds) {
      if (peerSessionId === input.sessionId) continue;
      const peer = await this.describe({
        projectId: input.projectId,
        sessionId: peerSessionId,
      });
      const peerPath = await canonicalPath(peer.path).catch(() =>
        path.resolve(peer.path),
      );
      if (peerPath === candidate) return true;
    }
    return false;
  }

  /**
   * Choose the chat's own worktree (ADR 0215). Nothing is checked out yet:
   * the chat's next turn creates it at the project folder's commit.
   */
  async plan(input: {
    projectId: string;
    sessionId: string;
  }): Promise<SessionCheckoutDescription> {
    const root = this.requireRoot(input.projectId);
    if (!(await this.worktreesAvailable(input.projectId)))
      throw new Error(
        "A worktree starts from a commit, and this project folder has none in Git yet.",
      );
    const commonDir = await canonicalCommonDir(root);
    await withRepositoryMutationLock(commonDir, async () => {
      if (await this.binding(input)) return;
      await this.save({
        sessionId: input.sessionId,
        projectId: input.projectId,
        path: this.managedPath(root, input),
        kind: "managed",
        branch: null,
      });
    });
    return this.describe(input);
  }

  /**
   * The chat's own worktree, checked out now: reused, checked out again
   * from its branch, or created at the project folder's commit (or at
   * `start`). A new checkout copies the project's listed ignored files.
   */
  async createManaged(input: {
    projectId: string;
    sessionId: string;
    ensureAvailable?(path: string): Promise<void>;
    /**
     * Start the worktree at `commit`, fetched from `ref` of the repository
     * at `repository` (the host's mirror of the project's remote, ADR 0178),
     * instead of the primary checkout's HEAD.
     */
    start?: { repository: string; ref: string; commit: string };
  }): Promise<SessionCheckoutBinding> {
    const root = this.requireRoot(input.projectId);
    const commonDir = await canonicalCommonDir(root);
    return withRepositoryMutationLock(commonDir, async () => {
      const existing = await this.binding(input);
      if (existing?.kind === "external") {
        await this.assertSameRepository(root, existing.path);
        await input.ensureAvailable?.(existing.path);
        return existing;
      }
      const worktreePath = existing?.path ?? this.managedPath(root, input);
      if (await exists(worktreePath)) {
        const registered = (await this.list(input.projectId)).find(
          (candidate) =>
            path.resolve(candidate.path) === path.resolve(worktreePath),
        );
        if (registered?.kind !== "managed")
          throw new Error(
            `The previous worktree folder at ${worktreePath} is no longer registered. Restore it before continuing.`,
          );
        await this.assertSameRepository(root, worktreePath);
        await input.ensureAvailable?.(worktreePath);
        const binding: SessionCheckoutBinding = {
          sessionId: input.sessionId,
          projectId: input.projectId,
          path: await canonicalPath(worktreePath),
          kind: "managed",
          branch: registered.branch,
        };
        await this.save(binding);
        return binding;
      }

      await fs.mkdir(path.dirname(worktreePath), { recursive: true });
      // A folder removed by hand leaves its registration behind.
      await git(root, ["worktree", "prune"]).catch(() => undefined);
      const kept =
        existing?.branch &&
        (await gitSucceeds(root, [
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${existing.branch}`,
        ]))
          ? existing.branch
          : null;
      const branch =
        kept ??
        (await this.availableBranch(
          root,
          existing?.branch ?? `${MANAGED_BRANCH_PREFIX}${sessionPrefix(input)}`,
        ));
      try {
        if (input.start)
          await git(root, [
            "fetch",
            "--quiet",
            "--no-tags",
            input.start.repository,
            input.start.ref,
          ]);
        await git(
          root,
          kept
            ? ["worktree", "add", worktreePath, kept]
            : [
                "worktree",
                "add",
                "-b",
                branch,
                worktreePath,
                ...(input.start ? [input.start.commit] : []),
              ],
        );
        await copyIncludedFiles({ root, worktree: worktreePath });
        const binding: SessionCheckoutBinding = {
          sessionId: input.sessionId,
          projectId: input.projectId,
          path: await canonicalPath(worktreePath),
          kind: "managed",
          branch,
        };
        await input.ensureAvailable?.(binding.path);
        await this.save(binding);
        return binding;
      } catch (cause) {
        await this.removeCheckout(root, worktreePath);
        // A branch made here goes with it; one the chat already had stays.
        if (!kept)
          await git(root, ["branch", "-D", branch]).catch(() => undefined);
        throw cause;
      }
    });
  }

  async adopt(input: {
    projectId: string;
    sessionId: string;
    path: string;
  }): Promise<SessionCheckoutBinding> {
    const root = this.requireRoot(input.projectId);
    const adoptedPath = await canonicalPath(input.path);
    await this.assertSameRepository(root, adoptedPath);
    const primary = await canonicalPath(root);
    if (adoptedPath === primary) {
      throw new Error("Use the primary checkout action for the project folder");
    }
    const worktree = (await this.list(input.projectId)).find(
      (candidate) => path.resolve(candidate.path) === adoptedPath,
    );
    if (!worktree) {
      throw new Error("The path is not a registered worktree for this project");
    }
    const status = await git(adoptedPath, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    if (status && worktree.kind !== "managed") {
      throw new Error(
        "The external worktree has uncommitted changes. Commit or clean them before assigning it to an agent session.",
      );
    }
    const binding: SessionCheckoutBinding = {
      sessionId: input.sessionId,
      projectId: input.projectId,
      path: adoptedPath,
      kind: worktree.kind === "managed" ? "managed" : "external",
      branch: worktree.branch,
    };
    await this.save(binding);
    return binding;
  }

  async returnPrimary(input: {
    projectId: string;
    sessionId: string;
  }): Promise<SessionCheckoutDescription> {
    const root = this.requireRoot(input.projectId);
    await this.deleteBinding(input.sessionId);
    return { path: root, kind: "primary", branch: null, present: true };
  }

  async withAssignmentLock<T>(input: {
    projectId: string;
    operation(): Promise<T>;
  }): Promise<T> {
    const root = this.requireRoot(input.projectId);
    const commonDir = await canonicalCommonDir(root);
    return withRepositoryMutationLock(commonDir, input.operation);
  }

  /**
   * Put a resting chat's own worktree away (ADR 0215): record what is in it
   * on its branch and remove the folder. The branch keeps the work; the
   * chat's next turn checks it out again. A worktree holding personal
   * files stays, because Git cannot record them.
   */
  async putAway(input: {
    projectId: string;
    sessionId: string;
  }): Promise<void> {
    const root = this.projectRoot(input.projectId);
    if (!root) return;
    const binding = await this.binding(input);
    if (binding?.kind !== "managed" || !(await exists(binding.path))) return;
    const commonDir = await canonicalCommonDir(root);
    await withRepositoryMutationLock(commonDir, async () => {
      if (!(await exists(binding.path))) return;
      if (await holdsFiles(path.join(binding.path, PROJECT_PERSONAL_DIR)))
        return;
      await this.assertSameRepository(root, binding.path);
      await this.recordChanges({
        workingDirectory: binding.path,
        message: "Put away with the chat",
      });
      await this.removeCheckout(root, binding.path);
    });
  }

  /**
   * Bring a chat's own worktree back into the project folder (ADR 0215):
   * its changes since it left the folder's history, merged three ways with
   * the folder's commit, written there as uncommitted changes. Refused,
   * changing nothing, on a conflict or when the folder's own uncommitted
   * changes touch the same files. Then the chat works in the project
   * folder, and its worktree and branch are gone.
   */
  async bringToProjectFolder(input: {
    projectId: string;
    sessionId: string;
  }): Promise<{ files: string[] }> {
    const root = this.requireRoot(input.projectId);
    const binding = await this.binding(input);
    if (binding?.kind !== "managed")
      throw new Error("This chat does not work in its own worktree.");
    const commonDir = await canonicalCommonDir(root);
    const files = await withRepositoryMutationLock(commonDir, async () => {
      const present = await exists(binding.path);
      if (present) {
        await this.assertSameRepository(root, binding.path);
        await this.recordChanges({
          workingDirectory: binding.path,
          message: "Bring changes to the project folder",
        });
      }
      const brought = binding.branch
        ? await this.applyToProjectFolder({
            root,
            branch: binding.branch,
            commonDir,
            sessionId: input.sessionId,
          })
        : [];
      if (present) await this.removeCheckout(root, binding.path);
      if (binding.branch)
        await git(root, ["branch", "-D", binding.branch]).catch(
          () => undefined,
        );
      await this.deleteBinding(input.sessionId);
      return brought;
    });
    this.notices.set(
      input.sessionId,
      files.length > 0
        ? `The person brought this chat's changes from its own worktree into the project folder (${root}) as uncommitted changes to ${files.length} ${files.length === 1 ? "file" : "files"}. The worktree is gone: you now work in the project folder.`
        : `The person moved this chat from its own worktree to the project folder (${root}); it had no changes to bring. You now work in the project folder.`,
    );
    return { files };
  }

  /**
   * Discard a chat's own worktree and its branch (ADR 0215); the chat
   * works in the project folder from its next turn.
   */
  async discard(input: {
    projectId: string;
    sessionId: string;
  }): Promise<void> {
    const root = this.requireRoot(input.projectId);
    const binding = await this.binding(input);
    if (binding?.kind !== "managed")
      throw new Error("This chat does not work in its own worktree.");
    const commonDir = await canonicalCommonDir(root);
    await withRepositoryMutationLock(commonDir, async () => {
      if (await exists(binding.path)) {
        await this.assertSameRepository(root, binding.path);
        await this.removeCheckout(root, binding.path);
      }
      if (binding.branch)
        await git(root, ["branch", "-D", binding.branch]).catch(
          () => undefined,
        );
      await this.deleteBinding(input.sessionId);
    });
    if (binding.branch)
      this.notices.set(
        input.sessionId,
        `The person discarded this chat's own worktree and its changes. You now work in the project folder (${root}); nothing from the worktree is there.`,
      );
  }

  /**
   * Run the Environment's and the person's setup in a chat's own worktree
   * (ADR 0208, 0215), recorded in the worktree's own Git directory so a
   * worktree checked out again sets up again.
   */
  async setup(input: {
    projectId: string;
    sessionId: string;
    workingDirectory: string;
    environment?: string;
    personal?: string;
    personalAllowed: boolean;
    timeoutMinutes: number;
    signal: AbortSignal;
    onRun(): Promise<void>;
  }): Promise<{ outcome: WorkspaceSetupOutcome; logPath: string }> {
    const root = this.requireRoot(input.projectId);
    await this.assertSameRepository(root, input.workingDirectory);
    const stateDirectory = (
      await git(input.workingDirectory, ["rev-parse", "--absolute-git-dir"])
    ).trim();
    return runNativeWorkspaceSetup({ ...input, stateDirectory });
  }

  /**
   * What the agent is told this turn about where it works: every turn in
   * a worktree, and once after the person moved the chat.
   */
  async notice(input: {
    projectId: string;
    sessionId: string;
  }): Promise<string | null> {
    const lines: string[] = [];
    const once = this.notices.get(input.sessionId);
    if (once) {
      this.notices.delete(input.sessionId);
      lines.push(once);
    }
    const root = this.projectRoot(input.projectId);
    const binding = root ? await this.binding(input) : null;
    if (root && binding?.kind === "managed")
      lines.push(
        `This chat works in its own Git worktree at ${binding.path}${binding.branch ? ` (branch ${binding.branch})` : ""}, not in the project folder (${root}). Its changes reach the project folder only when the person brings them there from the chat's status popup, or through a pull request.`,
      );
    else if (root && binding?.kind === "external")
      lines.push(
        `This chat works in the Git worktree at ${binding.path}${binding.branch ? ` (branch ${binding.branch})` : ""}, not in the project folder (${root}).`,
      );
    return lines.length > 0 ? lines.join("\n") : null;
  }

  /** Checkpoint an isolated checkout and return a named ref safe to push. */
  async preparePullRequest(input: {
    projectId: string;
    sessionId: string;
    message: string;
  }): Promise<{ path: string; branch: string }> {
    const description = await this.describe(input);
    if (description.kind === "primary") {
      throw new Error("The session is not using an isolated worktree");
    }
    if (description.kind === "managed" && !description.present) {
      throw new Error(
        "This chat's worktree is put away; send it a message to check it out again first.",
      );
    }
    if (description.kind === "managed") {
      await this.checkpoint({ ...input, workingDirectory: description.path });
    } else if (
      (await git(description.path, ["status", "--porcelain=v1"])).trim()
    ) {
      throw new Error(
        "Record your changes in Git before opening a pull request from this checkout.",
      );
    }
    let branch = (
      await git(description.path, ["branch", "--show-current"])
    ).trim();
    if (!branch) {
      branch = await this.availableBranch(
        this.requireRoot(input.projectId),
        `${MANAGED_BRANCH_PREFIX}${sessionPrefix(input)}-review`,
      );
      await git(description.path, ["switch", "-c", branch]);
    }
    const binding = await this.binding(input);
    if (binding && binding.branch !== branch) {
      await this.save({ ...binding, branch });
    }
    return { path: description.path, branch };
  }

  async checkpoint(input: {
    projectId: string;
    sessionId: string;
    workingDirectory: string;
    message: string;
  }): Promise<string | null> {
    const root = this.requireRoot(input.projectId);
    await this.assertSameRepository(root, input.workingDirectory);
    const commonDir = await canonicalCommonDir(input.workingDirectory);
    return withRepositoryMutationLock(commonDir, () =>
      this.recordChanges(input),
    );
  }

  /** The checkout's current commit, which a rollback of the next turn restores. */
  async head(input: { workingDirectory: string }): Promise<string | null> {
    try {
      const head = (
        await git(input.workingDirectory, [
          "rev-parse",
          "--verify",
          "--quiet",
          "HEAD",
        ])
      ).trim();
      return head || null;
    } catch {
      // Not a repository, or no commit yet: nothing a rollback could restore.
      return null;
    }
  }

  /**
   * Put a checkout's files back at `commit` for a rollback (ADR 0197), or
   * say why not. A worktree the chat owns is restored whatever is in it. A
   * person's own folder, or a worktree they assigned, only when it is still
   * where the chat's last turn left it (`expectedHead`, or `commit` when that
   * turn recorded none) and holds no other changes. Only files move: the
   * branch keeps every checkpoint, so a synced branch never rewinds, and the
   * next checkpoint records the rollback as a commit of its own.
   */
  async restore(input: {
    projectId: string;
    workingDirectory: string;
    commit: string;
    expectedHead: string | null;
    owned: boolean;
  }): Promise<"restored" | string> {
    const root = this.requireRoot(input.projectId);
    await this.assertSameRepository(root, input.workingDirectory);
    const commonDir = await canonicalCommonDir(input.workingDirectory);
    return withRepositoryMutationLock(commonDir, async () => {
      const cwd = input.workingDirectory;
      if (
        !(await gitSucceeds(cwd, [
          "cat-file",
          "-e",
          `${input.commit}^{commit}`,
        ]))
      )
        return "The checkpoint this turn started from is no longer in the repository, so the files were left as they are.";
      const head = await this.head({ workingDirectory: cwd });
      const status = await git(cwd, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]);
      if (!input.owned) {
        if (head !== (input.expectedHead ?? input.commit))
          return "This folder changed since the chat's last turn, so its files were left as they are. Fork the chat from that turn instead.";
        if (status)
          return "This folder has changes that are not recorded yet, so its files were left as they are. Record or discard them, then roll back again.";
      }
      if (head === input.commit && !status) return "restored";
      await git(cwd, [
        "restore",
        `--source=${input.commit}`,
        "--staged",
        "--worktree",
        "--",
        ":/",
      ]);
      // Files later turns created and never recorded; ignored and personal
      // files stay.
      if (input.owned) await git(cwd, ["clean", "-fd", "--", ":/"]);
      return "restored";
    });
  }

  private requireRoot(projectId: string): string {
    const root = this.projectRoot(projectId);
    if (!root) throw new Error(`Project '${projectId}' has no folder`);
    return root;
  }

  /**
   * Where a chat's own worktree lives: a folder of its own in host
   * storage, named after the project so editors and terminals show the
   * project's name.
   */
  private managedPath(
    root: string,
    input: { projectId: string; sessionId: string },
  ): string {
    return path.join(
      this.worktreesDirectory,
      input.projectId,
      input.sessionId,
      path.basename(path.resolve(root)) || "project",
    );
  }

  /** Commit everything in a checkout; the caller holds the repository lock. */
  private async recordChanges(input: {
    workingDirectory: string;
    message: string;
  }): Promise<string | null> {
    await ensurePersonalFilesExcluded({ repoPath: input.workingDirectory });
    const personalFiles = await git(input.workingDirectory, [
      "ls-files",
      "--",
      PROJECT_PERSONAL_DIR,
    ]);
    if (personalFiles.trim()) {
      throw new Error(
        "Personal files are tracked. Remove them from the git index before checkpointing or sharing this project.",
      );
    }
    const status = await git(input.workingDirectory, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    if (!status) return null;
    await git(input.workingDirectory, ["add", "-A"]);
    await git(input.workingDirectory, [
      "-c",
      `user.name=${AGENT_COMMIT_AUTHOR.name}`,
      "-c",
      `user.email=${AGENT_COMMIT_AUTHOR.email}`,
      "commit",
      "-m",
      input.message,
    ]);
    return (await git(input.workingDirectory, ["rev-parse", "HEAD"])).trim();
  }

  /**
   * Write `branch`'s changes since it left the project folder's history
   * into the project folder as uncommitted changes, or throw changing
   * nothing. The caller holds the repository lock.
   */
  private async applyToProjectFolder(input: {
    root: string;
    branch: string;
    commonDir: string;
    sessionId: string;
  }): Promise<string[]> {
    const { root, branch } = input;
    const head = (
      await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])
    ).trim();
    const merged = await gitRun(root, [
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      head,
      branch,
    ]);
    const [tree, ...conflicted] = merged.stdout.split("\n").filter(Boolean);
    if (merged.code === 1)
      throw new Error(
        `These changes conflict with the project folder's latest commits (${conflicted.slice(0, 5).join(", ")}). Ask the chat to merge the project folder's branch into its worktree first.`,
      );
    if (merged.code !== 0 || !tree)
      throw new Error(
        merged.stderr.trim() || "Git could not merge these changes.",
      );
    const files = nulSeparated(
      await git(root, ["diff", "--name-only", "-z", head, tree]),
    );
    if (files.length === 0) return [];
    const dirty = new Set(
      statusPaths(
        await git(root, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ]),
      ),
    );
    const overlap = files.filter((file) => dirty.has(file));
    if (overlap.length > 0)
      throw new Error(
        `The project folder has its own uncommitted changes to ${overlap.slice(0, 5).join(", ")}${overlap.length > 5 ? ` and ${overlap.length - 5} more` : ""}. Record or set them aside, then bring these changes again.`,
      );
    const patch = await git(root, [
      "diff",
      "--binary",
      "--no-color",
      "--no-ext-diff",
      "--no-renames",
      head,
      tree,
    ]);
    const applied = await gitRun(
      root,
      ["apply", "--whitespace=nowarn", "-"],
      patch,
    );
    if (applied.code !== 0)
      throw new Error(
        `The project folder could not take these changes: ${applied.stderr.trim() || "git apply failed"}`,
      );
    return files;
  }

  /**
   * Files a chat's own worktree changed since it left the project folder's
   * history: committed on its branch, and, while checked out, not yet.
   */
  private async changedFiles(input: {
    root: string;
    branch: string;
    worktree: string | null;
  }): Promise<number> {
    const base = (
      await git(input.root, ["merge-base", "HEAD", input.branch])
    ).trim();
    if (!input.worktree)
      return nulSeparated(
        await git(input.root, [
          "diff",
          "--name-only",
          "-z",
          base,
          input.branch,
        ]),
      ).length;
    const [tracked, untracked] = await Promise.all([
      git(input.worktree, ["diff", "--name-only", "-z", base]),
      git(input.worktree, ["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    return new Set([...nulSeparated(tracked), ...nulSeparated(untracked)]).size;
  }

  /** Remove a managed checkout's folder and registration; the branch stays. */
  private async removeCheckout(
    root: string,
    worktreePath: string,
  ): Promise<void> {
    const registered = await git(root, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ])
      .then(parseWorktreePorcelain)
      .catch(() => []);
    const exactRegistration = registered.some(
      (worktree) => path.resolve(worktree.path) === path.resolve(worktreePath),
    );
    if (exactRegistration) {
      await git(root, ["worktree", "remove", "--force", worktreePath]).catch(
        () => undefined,
      );
    }
    await fs.rm(worktreePath, { recursive: true, force: true });
    // The chat's own folder in host storage holds only its worktree, so it
    // goes too once empty.
    await fs.rmdir(path.dirname(worktreePath)).catch(() => undefined);
    await git(root, ["worktree", "prune", "--expire", "now"]).catch(
      () => undefined,
    );
  }

  private async assertSameRepository(
    root: string,
    candidate: string,
  ): Promise<void> {
    const [expected, actual] = await Promise.all([
      canonicalCommonDir(root),
      canonicalCommonDir(candidate),
    ]);
    if (expected !== actual) {
      throw new Error("The checkout must belong to the same Git repository");
    }
  }

  private async binding(input: {
    projectId: string;
    sessionId: string;
  }): Promise<SessionCheckoutBinding | null> {
    const result = await this.pglite.query<{
      session_id: string;
      project_id: string;
      path: string;
      kind: "managed" | "external";
      branch: string | null;
    }>(
      `SELECT session_id, project_id, path, kind, branch
       FROM desktop.session_checkouts
       WHERE session_id = $1 AND project_id = $2`,
      [input.sessionId, input.projectId],
    );
    const row = result.rows[0];
    return row
      ? {
          sessionId: row.session_id,
          projectId: row.project_id,
          path: row.path,
          kind: row.kind,
          branch: row.branch,
        }
      : null;
  }

  private async save(binding: SessionCheckoutBinding): Promise<void> {
    await this.pglite.query(
      `INSERT INTO desktop.session_checkouts
        (session_id, project_id, path, kind, branch)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (session_id) DO UPDATE SET
         project_id = EXCLUDED.project_id,
         path = EXCLUDED.path,
         kind = EXCLUDED.kind,
         branch = EXCLUDED.branch`,
      [
        binding.sessionId,
        binding.projectId,
        binding.path,
        binding.kind,
        binding.branch,
      ],
    );
  }

  private async deleteBinding(sessionId: string): Promise<void> {
    await this.pglite.query(
      "DELETE FROM desktop.session_checkouts WHERE session_id = $1",
      [sessionId],
    );
  }

  private async availableBranch(root: string, base: string): Promise<string> {
    let branch = base;
    for (let suffix = 1; ; suffix++) {
      if (
        !(await gitSucceeds(root, [
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${branch}`,
        ]))
      ) {
        return branch;
      }
      branch = `${base}-${suffix}`;
    }
  }
}

function sessionPrefix(input: { sessionId: string }): string {
  return input.sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "session";
}

/**
 * Copy the project folder's ignored files that `.worktreeinclude` lists
 * (gitignore syntax) into a new worktree (ADR 0215): never a symlink, never
 * over a file the worktree has.
 */
export async function copyIncludedFiles(input: {
  root: string;
  worktree: string;
}): Promise<string[]> {
  const includeFile = path.join(input.root, WORKTREE_INCLUDE_FILE);
  if (!(await exists(includeFile))) return [];
  const listed = nulSeparated(
    await git(input.root, [
      "ls-files",
      "--others",
      "--ignored",
      "-z",
      `--exclude-from=${includeFile}`,
    ]),
  );
  if (listed.length === 0) return [];
  // Only what the project ignores: anything else the worktree already has.
  const ignored = await gitRun(
    input.root,
    ["check-ignore", "-z", "--stdin"],
    `${listed.join("\0")}\0`,
  );
  const copied: string[] = [];
  for (const relative of nulSeparated(ignored.stdout)) {
    const source = path.join(input.root, relative);
    const target = path.join(input.worktree, relative);
    const stat = await fs.lstat(source).catch(() => null);
    if (!stat?.isFile()) continue;
    if (await exists(target)) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs
      .copyFile(source, target, fs.constants.COPYFILE_EXCL)
      .then(() => copied.push(relative))
      .catch(() => undefined);
  }
  return copied;
}
