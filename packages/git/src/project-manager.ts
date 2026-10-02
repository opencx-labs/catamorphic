import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PROJECT_GITIGNORE_PATH,
  PROJECT_MANIFEST_PATH,
} from "@catamorphic/workflow/project-layout";
import { FsBackend } from "./fs-backend.js";
import { push } from "./git-sync.js";
import { discoverLocalFolder } from "./native-git.js";
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
 * checkpoint walker's IGNORED_DIRS so git status and the walker agree on
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

  async checkpointSession(args: {
    tenantId: string;
    projectId: string;
    sessionId: string;
    message: string;
    author: { name: string; email: string };
  }): Promise<string> {
    const repo = await this.openSession(args);
    try {
      const sha = (await repo.status()).dirty
        ? await repo.commit(args.message, args.author)
        : await repo.resolveRef("HEAD");
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

  /**
   * The host's bare mirror of the project's linked remote, or null when
   * this storage keeps none (ADR 0178).
   */
  mirrorPath(args: { tenantId: string; projectId: string }): string | null {
    return this.storage.mirrorPath?.(args.tenantId, args.projectId) ?? null;
  }

  /**
   * Put a session's copy at a commit pinned in the project mirror and
   * publish it as the session's branch (ADR 0178). Whatever the copy held is
   * replaced: callers move the base only between turns, after the last
   * checkpoint, or on purpose (`reset`).
   */
  async setSessionBase(args: {
    tenantId: string;
    projectId: string;
    sessionId: string;
    pin: string;
    commit: string;
  }): Promise<void> {
    const mirrorPath = this.mirrorPath(args);
    if (!mirrorPath) throw new Error("This host keeps no project mirror");
    const repo = await this.openSession({
      tenantId: args.tenantId,
      projectId: args.projectId,
      sessionId: args.sessionId,
      refresh: true,
    });
    try {
      await copyFromMirror({
        mirrorPath,
        pin: args.pin,
        repoPath: repo.repoPath,
        into: "refs/work/base",
      });
      await repo.moveBranch("main", args.commit);
      await repo.checkout("main");
      await repo.resetWorkingTree();
      await this.publishSession({ ...args, repo, head: args.commit });
    } finally {
      await repo.dispose();
    }
  }

  /**
   * Move a session's copy to a new base pinned in the mirror (ADR 0178):
   * `reset` replaces its checkpoints, `rebase` replays them onto the new
   * base. A conflicting rebase leaves the copy as it was.
   */
  async moveSessionBase(args: {
    tenantId: string;
    projectId: string;
    sessionId: string;
    pin: string;
    from: string;
    to: string;
    update: "reset" | "rebase";
  }): Promise<BaseMoveOutcome> {
    const mirrorPath = this.mirrorPath(args);
    if (!mirrorPath) throw new Error("This host keeps no project mirror");
    const repo = await this.openSession({
      tenantId: args.tenantId,
      projectId: args.projectId,
      sessionId: args.sessionId,
      refresh: true,
    });
    try {
      const outcome = await moveCheckoutBase({
        repoPath: repo.repoPath,
        mirrorPath,
        pin: args.pin,
        from: args.from,
        to: args.to,
        update: args.update,
      });
      if (outcome.status === "moved")
        await this.publishSession({ ...args, repo, head: outcome.head });
      return outcome;
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
  }): Promise<void> {
    if (!this.remote) return;
    await push({
      dev: args.repo,
      remote: this.remote,
      tenantId: args.tenantId,
      projectId: args.projectId,
      remoteBranch: `sessions/${args.sessionId}`,
      localSha: args.head,
      force: true,
    });
  }

  /**
   * Put a session's copy back at one of its own commits, discarding what
   * came after (a rollback, ADR 0196), and publish it as the session's
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
