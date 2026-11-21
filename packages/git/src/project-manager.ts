import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PROJECT_GITIGNORE_PATH,
  PROJECT_MANIFEST_PATH,
} from "@catamorphic/workflow/project-layout";
import { FsBackend } from "./fs-backend.js";
import { push } from "./git-sync.js";
import { discoverLocalFolder, nativeGit } from "./native-git.js";
import { NativeProjectRepo } from "./native-project-repo.js";
import { cloneFromRemote } from "./network.js";
import {
  type DraftPublishResult,
  DraftsUnsupportedError,
  OriginDraftRepo,
  type ProjectDraft,
  publishFilesToOrigin,
} from "./origin-draft.js";
import { GitObjectCache } from "./origin-objects.js";
import { ProjectRepoImpl } from "./project-repo.js";
import {
  currentSessionWork,
  type SessionWork,
  writeCheckpoint,
} from "./session-checkpoint.js";
import type {
  DraftSupport,
  GitCredentials,
  ProjectPathResolver,
  ProjectRepo,
  RemoteBackend,
  StorageBackend,
} from "./types.js";
import {
  type BaseMoveOutcome,
  copyFromMirror,
  moveCheckoutBase,
} from "./workspace-mirror.js";

/**
 * Seeded into every new project (unless one exists): mirrors the
 * checkpoint walker's WALK_SKIPPED_DIRS so git status and the walker agree on
 * what a project's history never contains.
 */
export const PROJECT_GITIGNORE = `/app-data/
node_modules/
dist/
.turbo/
.DS_Store
`;

/** Stands in a copy while it is seeded; a copy still holding it is unfinished. */
const SEEDING_MARKER = ".git/work-seeding";

/**
 * The identity core reads the published program as when no member reads
 * it (roles, documents, tool rosters). It contains a NUL, which no stored
 * user id can hold, so it never names a member's draft; `openDraft` opens
 * the published program for it.
 */
export const PROGRAM_READER_ID = "\u0000program-reader";

const SYSTEM_AUTHOR = {
  name: "Work",
  email: "system@work.software",
};

export class ProjectManager {
  /** Origin objects this process has read; safe to lose. */
  private readonly objects = new GitObjectCache();
  private draftCheck: Promise<DraftSupport> | undefined;
  /** First-time copy preparations in flight, by tenant, project, and copy. */
  private readonly preparing = new Map<string, Promise<void>>();

  constructor(
    private readonly storage: StorageBackend,
    private readonly remote?: RemoteBackend,
    private readonly localRoots?: ProjectPathResolver,
  ) {}

  async open(
    tenantId: string,
    projectId: string,
    externalUserId?: string,
  ): Promise<ProjectRepo> {
    const { repoPath, release } = await this.storage.acquireProject(
      tenantId,
      projectId,
      externalUserId,
    );
    return (await this.localPath({ tenantId, projectId }))
      ? new NativeProjectRepo(projectId, repoPath, release)
      : new ProjectRepoImpl(projectId, repoPath, release);
  }

  /**
   * A member's draft of the program (ADR 0191). A project in a local folder
   * is its own draft, the folder itself. A project with a durable origin
   * keeps each member's draft as a ref in it (`refs/work/drafts/<member>`),
   * read and written as objects: every replica sees the same draft and none
   * holds it on disk. Only a host without an origin keeps a working copy
   * per member on this machine.
   */
  async openDraft(input: {
    tenantId: string;
    projectId: string;
    externalUserId: string;
  }): Promise<ProjectDraft> {
    if (input.externalUserId === PROGRAM_READER_ID)
      return this.openPublished(input);
    if (await this.localPath(input))
      return this.open(input.tenantId, input.projectId, input.externalUserId);
    if (this.remote) {
      const support = await this.draftSupport();
      if (!support.supported) throw new DraftsUnsupportedError(support.reason);
      return new OriginDraftRepo({
        ...input,
        remote: this.remote,
        cache: this.objects,
      });
    }
    return this.openCopy(input.tenantId, input.projectId, input.externalUserId);
  }

  /**
   * Whether this host's origin can keep members' drafts (ADR 0191), checked
   * once per process: hosts call it at boot to fail fast, and
   * {@link openDraft} refuses drafts on an origin that cannot keep them.
   */
  draftSupport(): Promise<DraftSupport> {
    // A check that could not run (a transient store error) is not an
    // answer: the next call asks again.
    this.draftCheck ??= (
      this.remote?.draftSupport
        ? this.remote.draftSupport()
        : Promise.resolve<DraftSupport>({ supported: true })
    ).catch((error: unknown) => {
      this.draftCheck = undefined;
      throw error;
    });
    return this.draftCheck;
  }

  /**
   * The published program, read by no member: a project's local folder, or
   * a read-only view of its origin's `main` (no draft is ever read or
   * created), or this machine's copy on a host without an origin.
   */
  async openPublished(input: {
    tenantId: string;
    projectId: string;
  }): Promise<ProjectDraft> {
    if (this.remote && !(await this.localPath(input)))
      return new OriginDraftRepo({
        ...input,
        externalUserId: null,
        remote: this.remote,
        cache: this.objects,
      });
    return this.open(input.tenantId, input.projectId);
  }

  /**
   * The folder a member's `store/` view is mirrored in around agent turns
   * when their draft has no folder of its own (a server draft), or null
   * when this storage keeps no local folders. A disposable cache: the
   * store itself lives behind the documents service.
   */
  async draftStoreFolder(input: {
    tenantId: string;
    projectId: string;
    externalUserId: string;
  }): Promise<string | null> {
    const folder = this.storage.cachePath?.(
      input.tenantId,
      input.projectId,
      `store-${input.externalUserId}`,
    );
    if (!folder) return null;
    await fs.mkdir(folder, { recursive: true });
    return folder;
  }

  /**
   * Publish files as one commit on the origin's `main`, never touching a
   * member's draft (ADR 0191). With `base`, the commit the files were
   * edited from, they merge with what was published since and report
   * conflicts instead of overwriting.
   */
  async publishFiles(input: {
    tenantId: string;
    projectId: string;
    files: Record<string, string>;
    base?: string;
    message: string;
    author: { name: string; email: string };
    guard?: (paths: readonly string[]) => void;
  }): Promise<DraftPublishResult> {
    if (!this.remote)
      throw new Error("Publishing requires durable project storage");
    return publishFilesToOrigin({
      ...input,
      remote: this.remote,
      cache: this.objects,
    });
  }

  /**
   * Open (creating if needed) this machine's working copy `copyId` of a
   * project, seeded from the origin's `main` when it is new: a session's
   * copy, or a member's copy on a host without an origin.
   */
  private async openCopy(
    tenantId: string,
    projectId: string,
    externalUserId: string,
  ): Promise<ProjectRepo> {
    // Two first opens of one copy in this process share one preparation,
    // so neither reads objects the other has not finished writing.
    const key = JSON.stringify([tenantId, projectId, externalUserId]);
    let pending = this.preparing.get(key);
    if (!pending) {
      pending = this.prepareCopy({
        tenantId,
        projectId,
        externalUserId,
      }).finally(() => this.preparing.delete(key));
      this.preparing.set(key, pending);
    }
    await pending;
    return this.open(tenantId, projectId, externalUserId);
  }

  /**
   * Create a copy seeded from the origin's `main` unless a complete one
   * exists. A marker stands in the copy while it is seeded: a seeding that
   * failed, or a process that stopped part way, leaves a copy the next open
   * starts over instead of treating as ready.
   */
  private async prepareCopy(args: {
    tenantId: string;
    projectId: string;
    externalUserId: string;
  }): Promise<void> {
    const { tenantId, projectId, externalUserId } = args;
    if (await this.storage.exists(tenantId, projectId, externalUserId)) {
      const { repoPath, release } = await this.storage.acquireProject(
        tenantId,
        projectId,
        externalUserId,
      );
      await release();
      const unfinished = await fs
        .access(path.join(repoPath, SEEDING_MARKER))
        .then(
          () => true,
          () => false,
        );
      if (!unfinished) return;
      await this.storage.deleteCopy(tenantId, projectId, externalUserId);
    }
    const repoPath = await this.storage.initProject(tenantId, projectId, {
      externalUserId,
    });
    if (!this.remote) return;
    const marker = path.join(repoPath, SEEDING_MARKER);
    await fs.writeFile(marker, "");
    const { release } = await this.storage.acquireProject(
      tenantId,
      projectId,
      externalUserId,
    );
    const repo = new ProjectRepoImpl(projectId, repoPath, release);
    try {
      await seedFromOrigin({
        remote: this.remote,
        tenantId,
        projectId,
        dev: repo,
      });
      await fs.rm(marker, { force: true });
    } catch (error) {
      await repo.dispose();
      await this.storage
        .deleteCopy(tenantId, projectId, externalUserId)
        .catch(() => {});
      throw error;
    }
    await repo.dispose();
  }

  /** An isolated origin snapshot, removed on disposal even with host-mapped projects. */
  async openEphemeral(args: {
    tenantId: string;
    projectId: string;
  }): Promise<ProjectRepo> {
    if (!this.remote)
      throw new Error("An ephemeral checkout requires durable project storage");
    const directory = await fs.mkdtemp(
      path.join(tmpdir(), "catamorphic-checkout-"),
    );
    const cleanup = () => fs.rm(directory, { recursive: true, force: true });
    try {
      const storage = new FsBackend(directory);
      const repoPath = await storage.initProject(args.tenantId, args.projectId);
      const repo = new ProjectRepoImpl(args.projectId, repoPath, cleanup);
      await seedFromOrigin({ remote: this.remote, ...args, dev: repo });
      return repo;
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  /** A recoverable session checkout; its branch never publishes project policy. */
  async openSession(args: {
    tenantId: string;
    projectId: string;
    sessionId: string;
    refresh?: boolean;
  }): Promise<ProjectRepo> {
    const userId = `session-${args.sessionId}`;
    const existed = await this.storage.exists(
      args.tenantId,
      args.projectId,
      userId,
    );
    const repo = await this.openCopy(args.tenantId, args.projectId, userId);
    try {
      if (this.remote && (!existed || args.refresh)) {
        const { fetchRemote } = await import("./git-sync.js");
        const fetched = await fetchRemote({
          dev: repo,
          remote: this.remote,
          tenantId: args.tenantId,
          projectId: args.projectId,
          remoteBranch: `sessions/${args.sessionId}`,
        });
        if (fetched.sha && fetched.sha !== (await repo.resolveRef("HEAD"))) {
          if ((await repo.status()).dirty)
            throw new Error(
              "Session has uncheckpointed work on this machine. Recover it before moving the session.",
            );
          await repo.moveBranch("main", fetched.sha);
          await repo.checkout("main");
        }
      }
      return repo;
    } catch (error) {
      await repo.dispose();
      throw error;
    }
  }

  /**
   * Checkpoint a session's copy (ADR 0342): one commit on the session's
   * ref whose tree is the copy's working tree and whose second parent is
   * the agent's HEAD, written when files changed or the agent's branch,
   * HEAD or pushed branch moved. The agent's commits must already be in
   * the copy. Returns the session's checkpoint, new or not.
   */
  async checkpointSession(args: {
    tenantId: string;
    projectId: string;
    sessionId: string;
    message: string;
    author: { name: string; email: string };
    /** The workspace's base: the agent's HEAD before its first checkpoint. */
    base: string;
    /** The agent's branch and HEAD as just saved; as recorded when left out. */
    work?: { head: string; branch: string };
    /** The branch this chat just pushed for a pull request (ADR 0343). */
    pushed?: { branch: string; commit: string };
  }): Promise<string> {
    const repo = await this.openSession(args);
    try {
      const sha = await this.checkpointCopy({ ...args, repo });
      if (this.remote)
        await push({
          dev: repo,
          remote: this.remote,
          tenantId: args.tenantId,
          projectId: args.projectId,
          remoteBranch: `sessions/${args.sessionId}`,
          localSha: sha,
        });
      return sha;
    } finally {
      await repo.dispose();
    }
  }

  private async checkpointCopy(args: {
    repo: ProjectRepo;
    sessionId: string;
    message: string;
    author: { name: string; email: string };
    base: string;
    work?: { head: string; branch: string };
    pushed?: { branch: string; commit: string };
  }): Promise<string> {
    const { repo } = args;
    const recorded = await currentSessionWork({
      repoPath: repo.repoPath,
      sessionId: args.sessionId,
      base: args.base,
    });
    const pushed = args.pushed ?? recorded.pushed;
    const work: SessionWork = {
      head: args.work?.head ?? recorded.head,
      branch: args.work?.branch ?? recorded.branch,
      ...(pushed ? { pushed } : {}),
    };
    const dirty = (await repo.status()).dirty;
    const moved =
      work.head !== recorded.head ||
      work.branch !== recorded.branch ||
      work.pushed?.branch !== recorded.pushed?.branch ||
      work.pushed?.commit !== recorded.pushed?.commit;
    if (!dirty && !moved) return recorded.checkpoint;
    // The working tree as a tree; the checkpoint then takes its place.
    const snapshot = dirty
      ? await repo.commit(args.message, args.author)
      : recorded.checkpoint;
    const sha = await writeCheckpoint({
      repoPath: repo.repoPath,
      tree: snapshot,
      previous: recorded.checkpoint,
      message: args.message,
      author: args.author,
      work,
    });
    await repo.moveBranch("main", sha);
    return sha;
  }

  /**
   * Where a session's work stands (ADR 0342): its checkpoint, its agent's
   * branch and HEAD, and the branch it last pushed.
   */
  async sessionWork(args: {
    tenantId: string;
    projectId: string;
    sessionId: string;
    base: string;
  }): Promise<SessionWork & { checkpoint: string }> {
    const repo = await this.openSession(args);
    try {
      return await currentSessionWork({
        repoPath: repo.repoPath,
        sessionId: args.sessionId,
        base: args.base,
      });
    } finally {
      await repo.dispose();
    }
  }

  /**
   * The host's bare mirror of the project's linked remote, or null when
   * this storage keeps none (ADR 0178).
   */
  mirrorPath(args: { tenantId: string; projectId: string }): string | null {
    return this.storage.mirrorPath?.(args.tenantId, args.projectId) ?? null;
  }

  /**
   * The commit the project's own `main` stands on: its origin's, or on a
   * host without one this machine's copy's. Where a chat starts when its
   * project has no linked repository (ADR 0342).
   */
  async mainCommit(args: {
    tenantId: string;
    projectId: string;
  }): Promise<string> {
    if (
      this.remote &&
      (await this.remote.exists(args.tenantId, args.projectId))
    ) {
      const sha = await this.remote.withOrigin(
        args.tenantId,
        args.projectId,
        (origin) => origin.resolveRef("refs/heads/main"),
      );
      if (sha) return sha;
    }
    const repo = await this.open(args.tenantId, args.projectId);
    try {
      return await repo.resolveRef("HEAD");
    } finally {
      await repo.dispose();
    }
  }

  /**
   * Make sure a session's copy holds its base commit: from the project
   * mirror where `pin` names it there, else from the project's own `main`.
   */
  private async bringBase(args: {
    tenantId: string;
    projectId: string;
    repo: ProjectRepo;
    pin?: string;
    commit: string;
  }): Promise<void> {
    const { repo } = args;
    if (args.pin) {
      const mirrorPath = this.mirrorPath(args);
      if (!mirrorPath) throw new Error("This host keeps no project mirror");
      await copyFromMirror({
        mirrorPath,
        pin: args.pin,
        repoPath: repo.repoPath,
        into: "refs/work/base",
      });
    } else if (this.remote) {
      const { fetchRemote } = await import("./git-sync.js");
      await fetchRemote({
        dev: repo,
        remote: this.remote,
        tenantId: args.tenantId,
        projectId: args.projectId,
        remoteBranch: "main",
      });
    } else {
      const main = await this.open(args.tenantId, args.projectId);
      try {
        if (path.resolve(main.repoPath) !== path.resolve(repo.repoPath))
          await nativeGit(repo.repoPath, [
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-write-fetch-head",
            main.repoPath,
            "+HEAD:refs/work/base",
          ]);
      } finally {
        await main.dispose();
      }
    }
    await nativeGit(repo.repoPath, [
      "cat-file",
      "-e",
      `${args.commit}^{commit}`,
    ]).catch(() => {
      throw new Error(
        `The workspace's base ${args.commit.slice(0, 12)} is not in the project's history on this host`,
      );
    });
  }

  /**
   * Put a session's copy at its base and publish it as the session's ref
   * (ADRs 0178, 0342): a commit pinned in the project mirror (`pin`), or
   * one the project's own origin holds. Whatever the copy held is replaced.
   */
  async setSessionBase(args: {
    tenantId: string;
    projectId: string;
    sessionId: string;
    /** The mirror ref that keeps the commit; left out for the origin's own. */
    pin?: string;
    commit: string;
  }): Promise<void> {
    const repo = await this.openSession({
      tenantId: args.tenantId,
      projectId: args.projectId,
      sessionId: args.sessionId,
      refresh: true,
    });
    try {
      await this.bringBase({ ...args, repo });
      await repo.moveBranch("main", args.commit);
      await repo.checkout("main");
      await repo.resetWorkingTree();
      await this.publishSession({ ...args, repo, head: args.commit });
    } finally {
      await repo.dispose();
    }
  }

  /**
   * Give a session that has saved work but no base one (ADR 0342): its
   * checkpoint becomes one on top of `commit`, with the same files, so its
   * sandbox comes back standing on the base with that work uncommitted.
   */
  async adoptSessionBase(args: {
    tenantId: string;
    projectId: string;
    sessionId: string;
    pin?: string;
    commit: string;
    message: string;
    author: { name: string; email: string };
  }): Promise<void> {
    const repo = await this.openSession({
      tenantId: args.tenantId,
      projectId: args.projectId,
      sessionId: args.sessionId,
      refresh: true,
    });
    try {
      await this.bringBase({ ...args, repo });
      const previous = await repo.resolveRef("HEAD");
      const snapshot = (await repo.status()).dirty
        ? await repo.commit(args.message, args.author)
        : previous;
      const sha = await writeCheckpoint({
        repoPath: repo.repoPath,
        tree: snapshot,
        previous,
        message: args.message,
        author: args.author,
        work: {
          head: args.commit,
          branch: (
            await currentSessionWork({
              repoPath: repo.repoPath,
              sessionId: args.sessionId,
              base: args.commit,
            })
          ).branch,
        },
      });
      await repo.moveBranch("main", sha);
      await this.publishSession({ ...args, repo, head: sha, force: false });
    } finally {
      await repo.dispose();
    }
  }

  /**
   * Move a session's work to a new base pinned in the mirror (ADRs 0178,
   * 0342). The agent's checkout is rebuilt in the copy, standing on its
   * HEAD with its saved files as one more commit, and moved as any checkout
   * is: `reset` discards its commits and changes, `rebase` replays its
   * commits and then its changes, which come back uncommitted. A rebase
   * that conflicts leaves the copy as it was. What results is the
   * session's next checkpoint, on top of the last.
   */
  async moveSessionBase(args: {
    tenantId: string;
    projectId: string;
    sessionId: string;
    pin: string;
    from: string;
    to: string;
    update: "reset" | "rebase";
    author: { name: string; email: string };
  }): Promise<BaseMoveOutcome> {
    const mirrorPath = this.mirrorPath(args);
    if (!mirrorPath) throw new Error("This host keeps no project mirror");
    const repo = await this.openSession({
      tenantId: args.tenantId,
      projectId: args.projectId,
      sessionId: args.sessionId,
      refresh: true,
    });
    const git = (gitArgs: readonly string[]) =>
      nativeGit(repo.repoPath, gitArgs).then((output) => output.trim());
    try {
      // Whatever the copy holds beyond its last checkpoint is work too.
      await this.checkpointCopy({
        repo,
        sessionId: args.sessionId,
        message: "Save the workspace before moving its base",
        author: args.author,
        base: args.from,
      });
      const work = await currentSessionWork({
        repoPath: repo.repoPath,
        sessionId: args.sessionId,
        base: args.from,
      });
      // The agent's uncommitted changes ride along as one commit on its
      // HEAD, so a rebase replays them and reports their conflicts.
      const uncommitted =
        (await git(["rev-parse", `${work.checkpoint}^{tree}`])) !==
        (await git(["rev-parse", `${work.head}^{tree}`]));
      const marker = `Work: uncommitted changes ${work.checkpoint}`;
      const start = uncommitted
        ? await git([
            "-c",
            `user.name=${args.author.name}`,
            "-c",
            `user.email=${args.author.email}`,
            "commit-tree",
            `${work.checkpoint}^{tree}`,
            "-p",
            work.head,
            "-m",
            marker,
          ])
        : work.head;
      const stand = async (commit: string) => {
        await git(["update-ref", "--no-deref", "HEAD", commit]);
        await git(["reset", "--quiet"]);
      };
      await stand(start);
      let outcome: BaseMoveOutcome;
      let moved: { tip: string; head: string } | undefined;
      try {
        outcome = await moveCheckoutBase({
          repoPath: repo.repoPath,
          mirrorPath,
          pin: args.pin,
          from: args.from,
          to: args.to,
          update: args.update,
        });
        if (outcome.status === "moved") {
          const tip = outcome.head;
          // The changes' commit is gone when the new base already has them.
          const carried =
            uncommitted &&
            args.update === "rebase" &&
            (await git(["log", "-1", "--format=%s", tip])) === marker;
          moved = {
            tip,
            head: carried ? await git(["rev-parse", `${tip}^`]) : tip,
          };
        }
      } finally {
        // Back on the session's checkpoints, whatever happened.
        await git(["symbolic-ref", "HEAD", "refs/heads/main"]);
      }
      if (!moved) {
        await git(["reset", "--quiet"]);
        return { ...outcome, head: work.head };
      }
      const sha = await writeCheckpoint({
        repoPath: repo.repoPath,
        tree: moved.tip,
        previous: work.checkpoint,
        message:
          args.update === "reset"
            ? "Reset the workspace to a new base"
            : "Rebase the workspace onto a new base",
        author: args.author,
        work: {
          head: moved.head,
          branch: work.branch,
          ...(work.pushed ? { pushed: work.pushed } : {}),
        },
      });
      await repo.moveBranch("main", sha);
      await git(["reset", "--quiet"]);
      await this.publishSession({ ...args, repo, head: sha, force: false });
      return { status: "moved", head: moved.head };
    } finally {
      await repo.dispose();
    }
  }

  private async publishSession(args: {
    tenantId: string;
    projectId: string;
    sessionId: string;
    repo: ProjectRepo;
    head: string;
    /** False for a checkpoint on top of the last; default true. */
    force?: boolean;
  }): Promise<void> {
    if (!this.remote) return;
    await push({
      dev: args.repo,
      remote: this.remote,
      tenantId: args.tenantId,
      projectId: args.projectId,
      remoteBranch: `sessions/${args.sessionId}`,
      localSha: args.head,
      force: args.force ?? true,
    });
  }

  /**
   * Put a session's copy back at one of its own commits, discarding what
   * came after (a rollback, ADR 0197), and publish it as the session's
   * branch so its next sandbox is seeded from there.
   */
  async resetSession(args: {
    tenantId: string;
    projectId: string;
    sessionId: string;
    commit: string;
  }): Promise<void> {
    const repo = await this.openSession({
      tenantId: args.tenantId,
      projectId: args.projectId,
      sessionId: args.sessionId,
      refresh: true,
    });
    try {
      await repo.moveBranch("main", args.commit);
      await repo.checkout("main");
      await repo.resetWorkingTree();
      await this.publishSession({ ...args, repo, head: args.commit });
    } finally {
      await repo.dispose();
    }
  }

  /**
   * Forget a closed session's workspace: its `sessions/<id>` branch on the
   * origin and its `session-<id>` copy on this machine. Commits already
   * reachable elsewhere stay; missing pieces are no-ops.
   */
  async deleteSession(args: {
    tenantId: string;
    projectId: string;
    sessionId: string;
  }): Promise<void> {
    if (
      this.remote &&
      (await this.remote.exists(args.tenantId, args.projectId))
    )
      await this.remote.withOrigin(args.tenantId, args.projectId, (origin) =>
        origin.deleteRef({ ref: `refs/heads/sessions/${args.sessionId}` }),
      );
    await this.storage.deleteCopy(
      args.tenantId,
      args.projectId,
      `session-${args.sessionId}`,
    );
  }

  async localPath(input: {
    tenantId: string;
    projectId: string;
  }): Promise<string | null> {
    return (await this.localRoots?.(input.tenantId, input.projectId)) ?? null;
  }

  async create(
    tenantId: string,
    projectId: string,
    opts?: {
      name?: string;
      initialFiles?: Record<string, string>;
      externalUserId?: string;
      /** Explicit directory for the working copy (user-visible folder). */
      rootPath?: string;
      /**
       * Attach an existing Git checkout without writing files or history.
       * The host handles explicit initialization of folders without Git.
       */
      importExisting?: boolean;
      /**
       * Start with no files at all: another authority fills the copy (a
       * member's local copy of a server project), so no local manifest or
       * seed may compete with the server's own on the first sync.
       */
      empty?: boolean;
      /**
       * Populate the working copy by cloning a network git remote (e.g. a
       * GitHub repo) instead of scaffolding. Mutually exclusive with
       * `importExisting`; `initialFiles` are skipped so the imported history
       * stays pristine.
       */
      cloneFrom?: {
        url: string;
        credentials?: GitCredentials;
        branch?: string;
      };
    },
  ): Promise<ProjectRepo> {
    if (opts?.importExisting) {
      if (!opts.rootPath)
        throw new Error("Opening a repository requires its folder path");
      const checkout = await discoverLocalFolder({ path: opts.rootPath });
      const local = await this.localPath({ tenantId, projectId });
      if (!local || (await fs.realpath(local)) !== checkout.path)
        throw new Error(
          "Register the checkout's canonical folder with localCheckouts before importing it",
        );
      return new NativeProjectRepo(projectId, checkout.path, async () => {});
    }
    const repoPath = await this.storage.initProject(tenantId, projectId, {
      externalUserId: opts?.externalUserId,
      rootPath: opts?.rootPath,
    });
    const projectName = opts?.name ?? "my-project";
    const local = await this.localPath({ tenantId, projectId });

    if (opts?.cloneFrom) {
      await cloneFromRemote({
        repoPath,
        native: Boolean(local),
        url: opts.cloneFrom.url,
        credentials: opts.cloneFrom.credentials,
        branch: opts.cloneFrom.branch,
      });
      const repo = local
        ? new NativeProjectRepo(projectId, repoPath, async () => {})
        : new ProjectRepoImpl(projectId, repoPath, async () => {});
      if (this.remote && !local) {
        await this.remote.initRemote(tenantId, projectId);
        await push({
          dev: repo,
          remote: this.remote,
          tenantId,
          projectId,
          remoteBranch: "main",
        });
      }
      return repo;
    }

    // No eager workspace scaffold (ADR 0043): a blank project is a git repo,
    // a manifest, and whatever `initialFiles` (seed skills or a template's
    // file map) provide. The workflow workspace arrives on demand.
    const manifestPath = path.join(repoPath, PROJECT_MANIFEST_PATH);
    const manifestExists = await fs.access(manifestPath).then(
      () => true,
      () => false,
    );
    if (!manifestExists && !opts?.empty) {
      await fs.mkdir(path.dirname(manifestPath), { recursive: true });
      await fs.writeFile(
        manifestPath,
        `${JSON.stringify(
          {
            name: projectName,
            environments: {
              default: {
                description: "Run where this host places work",
                workloads: ["agent", "workflow"],
              },
            },
            defaultEnvironment: "default",
          },
          null,
          2,
        )}\n`,
      );
    }

    // Every project gets ignore rules from birth: without them the first
    // `bun install` floods git status (and every changes UI) with the
    // whole node_modules tree. Never overwrite one the user already has.
    const gitignorePath = path.join(repoPath, PROJECT_GITIGNORE_PATH);
    const gitignoreExists = await fs.access(gitignorePath).then(
      () => true,
      () => false,
    );
    if (!gitignoreExists && !opts?.empty) {
      await fs.writeFile(gitignorePath, PROJECT_GITIGNORE);
    }

    if (opts?.initialFiles && !opts.empty) {
      for (const [filePath, content] of Object.entries(opts.initialFiles)) {
        const fullPath = path.join(repoPath, filePath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content);
      }
    }

    // Use the path initProject returned rather than re-acquiring: when the
    // host supplies an explicit rootPath, that path is the initialized checkout.
    const repo = local
      ? new NativeProjectRepo(projectId, repoPath, async () => {})
      : new ProjectRepoImpl(projectId, repoPath, async () => {});

    const hasHead = await repo.resolveRef("HEAD").then(
      () => true,
      () => false,
    );
    if (!hasHead) {
      // An empty copy (another authority fills it) still starts a history.
      await repo.commit("Initial commit", SYSTEM_AUTHOR, { allowEmpty: true });
    }

    if (this.remote) {
      await this.remote.initRemote(tenantId, projectId);
      await push({
        dev: repo,
        remote: this.remote,
        tenantId,
        projectId,
        remoteBranch: "main",
      });
    }

    return repo;
  }

  async delete(tenantId: string, projectId: string): Promise<void> {
    await this.storage.deleteProject(tenantId, projectId);
    if (this.remote) {
      await this.remote.deleteRemote(tenantId, projectId).catch(() => {});
    }
  }

  async exists(
    tenantId: string,
    projectId: string,
    externalUserId?: string,
  ): Promise<boolean> {
    return this.storage.exists(tenantId, projectId, externalUserId);
  }

  get remoteBackend(): RemoteBackend | undefined {
    return this.remote;
  }
}

async function seedFromOrigin(opts: {
  remote: RemoteBackend;
  tenantId: string;
  projectId: string;
  dev: ProjectRepo;
}): Promise<void> {
  const { fetchRemote } = await import("./git-sync.js");
  const fetched = await fetchRemote({
    dev: opts.dev,
    remote: opts.remote,
    tenantId: opts.tenantId,
    projectId: opts.projectId,
    remoteBranch: "main",
  });
  if (fetched.sha) {
    const nodeFs = (await import("node:fs")).default;
    const git = (await import("isomorphic-git")).default;
    await git.writeRef({
      fs: nodeFs,
      dir: opts.dev.repoPath,
      ref: "refs/heads/main",
      value: fetched.sha,
      force: true,
    });
    await git.checkout({
      fs: nodeFs,
      dir: opts.dev.repoPath,
      ref: "main",
      force: true,
    });
  }
}
