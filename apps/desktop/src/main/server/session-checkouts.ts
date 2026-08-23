import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { PGlite } from "@electric-sql/pglite";

const execFileAsync = promisify(execFile);

export type SessionCheckoutKind = "primary" | "managed" | "external";

export interface SessionCheckoutBinding {
  sessionId: string;
  projectId: string;
  path: string;
  kind: Exclude<SessionCheckoutKind, "primary">;
  branch: string | null;
}

export interface SessionCheckoutDescription {
  path: string;
  kind: SessionCheckoutKind;
  branch: string | null;
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
  projectRoot: (projectId: string) => string | undefined;
}

const repositoryMutationLocks = new Map<string, Promise<void>>();

async function git(cwd: string, args: string[]): Promise<string> {
  return (
    await execFileAsync("git", ["-C", cwd, ...args], {
      maxBuffer: 16 * 1024 * 1024,
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

async function canonicalCommonDir(cwd: string): Promise<string> {
  const raw = (await git(cwd, ["rev-parse", "--git-common-dir"])).trim();
  return fs.realpath(path.isAbsolute(raw) ? raw : path.resolve(cwd, raw));
}

async function canonicalPath(filePath: string): Promise<string> {
  return fs.realpath(path.resolve(filePath));
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
 * means the project's primary folder; creation is an explicit agent action.
 */
export class SessionCheckouts {
  private readonly pglite: PGlite;
  private readonly projectRoot: SessionCheckoutsOptions["projectRoot"];
  private readonly recoveryWarnings = new Map<string, string>();

  constructor(options: SessionCheckoutsOptions) {
    this.pglite = options.pglite;
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
    try {
      await this.assertSameRepository(root, binding.path);
      return await canonicalPath(binding.path);
    } catch {
      await this.deleteBinding(input.sessionId);
      this.recoveryWarnings.set(
        input.sessionId,
        `The assigned checkout at ${binding.path} is no longer usable. This session has returned to the primary project checkout. Re-check concurrent work before editing.`,
      );
      return root;
    }
  }

  takeRecoveryWarning(sessionId: string): string | null {
    const warning = this.recoveryWarnings.get(sessionId) ?? null;
    this.recoveryWarnings.delete(sessionId);
    return warning;
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
      ? { path: resolved, kind: binding.kind, branch: binding.branch }
      : { path: resolved, kind: "primary", branch: null };
  }

  async list(projectId: string): Promise<ClassifiedRepositoryWorktree[]> {
    const root = this.requireRoot(projectId);
    const primary = await canonicalPath(root);
    const configuredManagedRoot = path.resolve(
      root,
      ".catamorphic",
      "worktrees",
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

  async assigned(projectId: string): Promise<
    Array<{
      sessionId: string;
      kind: "managed" | "external";
      branch: string | null;
    }>
  > {
    const result = await this.pglite.query<{
      session_id: string;
      kind: "managed" | "external";
      branch: string | null;
    }>(
      `SELECT session_id, kind, branch
       FROM desktop.session_checkouts
       WHERE project_id = $1
       ORDER BY created_at`,
      [projectId],
    );
    const assigned: Array<{
      sessionId: string;
      kind: "managed" | "external";
      branch: string | null;
    }> = [];
    for (const row of result.rows) {
      const description = await this.describe({
        projectId,
        sessionId: row.session_id,
      });
      if (description.kind === "primary") continue;
      assigned.push({
        sessionId: row.session_id,
        kind: description.kind,
        branch: description.branch,
      });
    }
    return assigned;
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

  async createManaged(input: {
    projectId: string;
    sessionId: string;
    ensureAvailable?(path: string): Promise<void>;
  }): Promise<SessionCheckoutBinding> {
    const root = this.requireRoot(input.projectId);
    const commonDir = await canonicalCommonDir(root);
    return withRepositoryMutationLock(commonDir, async () => {
      const existing = await this.binding(input);
      if (existing) {
        await this.assertSameRepository(root, existing.path);
        await input.ensureAvailable?.(existing.path);
        return existing;
      }
      const worktreesRoot = path.join(root, ".catamorphic", "worktrees");
      const worktreePath = path.join(worktreesRoot, input.sessionId);
      await this.excludeManagedWorktrees(root);
      await fs.mkdir(worktreesRoot, { recursive: true });
      const pathExists = await fs.access(worktreePath).then(
        () => true,
        () => false,
      );
      if (pathExists) {
        throw new Error(
          `Managed worktree path already exists: ${worktreePath}`,
        );
      }

      const prefix = input.sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
      const branch = await this.availableBranch(
        root,
        `catamorphic/${prefix || "session"}`,
      );
      try {
        await git(root, ["worktree", "add", "-b", branch, worktreePath]);
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
        await this.cleanupManagedCreation(root, worktreePath, branch);
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
    if (status) {
      throw new Error(
        "The external worktree has uncommitted changes. Commit or clean them before assigning it to an agent session.",
      );
    }
    const binding: SessionCheckoutBinding = {
      sessionId: input.sessionId,
      projectId: input.projectId,
      path: adoptedPath,
      kind: "external",
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
    return { path: root, kind: "primary", branch: null };
  }

  async withAssignmentLock<T>(input: {
    projectId: string;
    operation(): Promise<T>;
  }): Promise<T> {
    const root = this.requireRoot(input.projectId);
    const commonDir = await canonicalCommonDir(root);
    return withRepositoryMutationLock(commonDir, input.operation);
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
    await this.checkpoint({
      ...input,
      workingDirectory: description.path,
    });
    let branch = (
      await git(description.path, ["branch", "--show-current"])
    ).trim();
    if (!branch) {
      const prefix = input.sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
      branch = await this.availableBranch(
        this.requireRoot(input.projectId),
        `catamorphic/${prefix || "session"}-review`,
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
    return withRepositoryMutationLock(commonDir, async () => {
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
        "user.name=Catamorphic Agent",
        "-c",
        "user.email=agent@catamorphic.dev",
        "commit",
        "-m",
        input.message,
      ]);
      return (await git(input.workingDirectory, ["rev-parse", "HEAD"])).trim();
    });
  }

  private requireRoot(projectId: string): string {
    const root = this.projectRoot(projectId);
    if (!root) throw new Error(`Project '${projectId}' has no folder`);
    return root;
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

  private async excludeManagedWorktrees(root: string): Promise<void> {
    const gitDir = (await git(root, ["rev-parse", "--git-dir"])).trim();
    const excludePath = path.join(
      path.isAbsolute(gitDir) ? gitDir : path.resolve(root, gitDir),
      "info",
      "exclude",
    );
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    const current = await fs.readFile(excludePath, "utf8").catch(() => "");
    const rule = "/.catamorphic/worktrees/";
    if (current.split(/\r?\n/).includes(rule)) return;
    await fs.appendFile(
      excludePath,
      `${current && !current.endsWith("\n") ? "\n" : ""}${rule}\n`,
    );
  }

  private async cleanupManagedCreation(
    root: string,
    worktreePath: string,
    branch: string,
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
    await git(root, ["worktree", "prune", "--expire", "now"]).catch(
      () => undefined,
    );
    await git(root, ["branch", "-D", branch]).catch(() => undefined);
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
