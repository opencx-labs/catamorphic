import { type FSWatcher, watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ensurePersonalFilesExcluded } from "@catamorphic/git";
import type {
  PersonalEnvironmentServerState,
  PersonalEnvironmentView,
} from "../shared/personal-environment.js";
import {
  type ListedFile,
  PERSONAL_ENVIRONMENT_PATH,
  PERSONAL_ENVIRONMENT_STATUS_PATH,
  type PersonalEnvironmentConfig,
  readListedFiles,
  readPersonalEnvironmentConfig,
  sha256,
} from "./personal-environment-config.js";
import {
  RemoteAuthError,
  type RemotePersonalEnvironment,
  type RemotePersonalEnvironmentUpload,
  type RemoteProjectClient,
} from "./remote-sync.js";

/**
 * Keeps each linked project's remote environment (ADR 0184) current: the
 * member's listed files, sent to the Work server when they change and
 * checked on a timer and on focus. Sign-ins are never sent: they stay on
 * the machine they were made on (ADR 0199).
 */

/** How often each linked server is asked about the environment. */
export const REMOTE_CHECK_MS = 2 * 60_000;
/** How often listed files are compared with what was sent. */
export const LOCAL_CHECK_MS = 30_000;

export interface PersonalEnvironmentLink {
  profileId: string;
  localProjectId: string;
  serverUrl: string;
  /** Null while the project's server sign-in needs renewing. */
  client: Pick<
    RemoteProjectClient,
    | "personalEnvironment"
    | "putPersonalEnvironment"
    | "deletePersonalEnvironment"
  > | null;
}

export interface PersonalEnvironmentSnapshot {
  files: ListedFile[];
  fingerprint: string;
}

export function snapshotFingerprint(args: {
  files: readonly ListedFile[];
}): string {
  return sha256(
    JSON.stringify({
      files: args.files.flatMap((file) =>
        file.fingerprint ? [[file.path, file.fingerprint]] : [],
      ),
    }),
  );
}

export function uploadFromSnapshot(
  snapshot: PersonalEnvironmentSnapshot,
): RemotePersonalEnvironmentUpload {
  return {
    files: snapshot.files.flatMap((file) =>
      file.content
        ? [{ path: file.path, content: file.content.toString("base64") }]
        : [],
    ),
  };
}

/** Whether this desktop should (re)send the member's environment. */
export function shouldUpload(args: {
  snapshot: PersonalEnvironmentSnapshot;
  lastSentFingerprint: string | null;
  remote: RemotePersonalEnvironment;
}): boolean {
  if (!args.remote.allowed) return false;
  if (args.lastSentFingerprint !== args.snapshot.fingerprint) return true;
  // The server's copy drifted from what was sent (restored, cleared, or
  // replaced by another of the member's computers): send it again.
  const remoteFiles = args.remote.files.map((file) => file.path).sort();
  const localFiles = args.snapshot.files
    .filter((file) => file.content)
    .map((file) => file.path)
    .sort();
  return remoteFiles.join("\u0000") !== localFiles.join("\u0000");
}

interface LinkState {
  lastSentFingerprint: string | null;
  lastSyncAt: string | null;
  lastCheckedAt: string | null;
  server: PersonalEnvironmentServerState;
  remote: RemotePersonalEnvironment | null;
  config: {
    exists: boolean;
    error: string | null;
    config: PersonalEnvironmentConfig | null;
  };
  files: ListedFile[];
  error: string | null;
  running: Promise<void> | null;
  again: boolean;
  statusText: string | null;
  configFingerprint: string | null;
  /** The local snapshot seen by the last run. */
  localFingerprint: string | null;
  /** Watched folder to the file names that matter in it. */
  watchers: Map<string, { names: string; watcher: FSWatcher }>;
  debounce: NodeJS.Timeout | null;
}

export interface PersonalEnvironmentSyncDeps {
  links(): PersonalEnvironmentLink[];
  projectRoot(projectId: string): Promise<string | null>;
  now?: () => number;
  /** Watch the config and listed files for immediate changes. */
  watchFiles?: boolean;
  /** Write the secret-free status file agents read. */
  writeStatusFile?: boolean;
}

export class PersonalEnvironmentSync {
  private readonly states = new Map<string, LinkState>();
  private readonly listeners = new Set<
    (change: { profileId: string; projectId: string }) => void
  >();
  private timers: NodeJS.Timeout[] = [];
  private lastFullCheck = 0;
  private stopped = false;

  constructor(private readonly deps: PersonalEnvironmentSyncDeps) {}

  start(): void {
    this.stopped = false;
    this.timers.push(
      setTimeout(() => void this.checkAll(), 5_000),
      setInterval(() => void this.checkAll(), REMOTE_CHECK_MS),
      setInterval(() => void this.checkLocal(), LOCAL_CHECK_MS),
    );
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    for (const state of this.states.values()) {
      if (state.debounce) clearTimeout(state.debounce);
      for (const { watcher } of state.watchers.values()) watcher.close();
      state.watchers.clear();
    }
  }

  subscribe(
    listener: (change: { profileId: string; projectId: string }) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Window focus: ask again unless a check just ran. */
  nudge(): void {
    if (this.now() - this.lastFullCheck > 60_000) void this.checkAll();
  }

  async checkAll(): Promise<void> {
    this.lastFullCheck = this.now();
    const links = this.deps.links();
    this.forgetUnlinked(links);
    await Promise.all(links.map((link) => this.sync(link).catch(() => {})));
  }

  /** A disconnected project stops watching and forgets what it sent. */
  private forgetUnlinked(links: readonly PersonalEnvironmentLink[]): void {
    const live = new Set(
      links.map((link) => linkKey(link.profileId, link.localProjectId)),
    );
    for (const [id, state] of this.states) {
      if (live.has(id)) continue;
      if (state.debounce) clearTimeout(state.debounce);
      for (const { watcher } of state.watchers.values()) watcher.close();
      this.states.delete(id);
    }
  }

  /** Current view, starting a check when this link was never checked. */
  view(args: {
    profileId: string;
    projectId: string;
  }): PersonalEnvironmentView {
    const link = this.link(args);
    const state = this.states.get(linkKey(args.profileId, args.projectId));
    if (link && !state?.lastCheckedAt && !state?.running)
      void this.sync(link).catch(() => {});
    return this.render(args.projectId, state, Boolean(state?.running));
  }

  /** Check and send now; resolves with the resulting view. */
  async syncNow(args: {
    profileId: string;
    projectId: string;
  }): Promise<PersonalEnvironmentView> {
    const link = this.link(args);
    if (!link) throw new Error("This project is not connected to a server");
    await this.sync(link);
    return this.render(
      args.projectId,
      this.states.get(linkKey(args.profileId, args.projectId)),
      false,
    );
  }

  private async checkLocal(): Promise<void> {
    const links = this.deps.links();
    this.forgetUnlinked(links);
    for (const link of links) {
      const state = this.states.get(
        linkKey(link.profileId, link.localProjectId),
      );
      if (state?.server !== "allowed" || state.running) continue;
      const root = await this.deps.projectRoot(link.localProjectId);
      if (!root) continue;
      try {
        const local = await this.collect(root);
        // Local changes only; the remote check retries failed sends.
        if (
          local.configFingerprint !== state.configFingerprint ||
          (local.snapshot?.fingerprint ?? null) !== state.localFingerprint
        )
          void this.sync(link).catch(() => {});
      } catch {
        // The next remote check reports the problem.
      }
    }
  }

  private link(args: {
    profileId: string;
    projectId: string;
  }): PersonalEnvironmentLink | undefined {
    return this.deps
      .links()
      .find(
        (link) =>
          link.profileId === args.profileId &&
          link.localProjectId === args.projectId,
      );
  }

  /** One run per link at a time; a request during a run runs once more. */
  private sync(link: PersonalEnvironmentLink): Promise<void> {
    const state = this.state(link);
    if (state.running) {
      state.again = true;
      return state.running;
    }
    state.running = (async () => {
      try {
        do {
          state.again = false;
          try {
            await this.run(link, state);
          } finally {
            // Every outcome reaches agents, including sign-in and
            // unreachable states that end a run early.
            const root = await this.deps.projectRoot(link.localProjectId);
            if (root) await this.writeStatus(root, state);
          }
        } while (state.again && !this.stopped);
      } finally {
        state.running = null;
        this.emit(link);
      }
    })();
    this.emit(link);
    return state.running;
  }

  private async collect(root: string): Promise<{
    configFingerprint: string;
    config: PersonalEnvironmentConfig | null;
    exists: boolean;
    error: string | null;
    files: ListedFile[];
    snapshot: PersonalEnvironmentSnapshot | null;
  }> {
    const file = await readPersonalEnvironmentConfig({ root });
    if (!file.parsed.ok)
      return {
        configFingerprint: file.fingerprint,
        config: null,
        exists: file.exists,
        error: file.parsed.error,
        files: [],
        snapshot: null,
      };
    const config = file.parsed.config;
    const files = await readListedFiles({ root, files: config.files });
    return {
      configFingerprint: file.fingerprint,
      config,
      exists: file.exists,
      error: null,
      files,
      snapshot: { files, fingerprint: snapshotFingerprint({ files }) },
    };
  }

  private async run(
    link: PersonalEnvironmentLink,
    state: LinkState,
  ): Promise<void> {
    const root = await this.deps.projectRoot(link.localProjectId);
    if (!root) {
      state.error = "The project folder is unavailable";
      return;
    }
    const local = await this.collect(root);
    state.configFingerprint = local.configFingerprint;
    state.localFingerprint = local.snapshot?.fingerprint ?? null;
    state.config = {
      exists: local.exists,
      error: local.error,
      config: local.config,
    };
    state.files = local.files;
    state.error = null;
    this.reconcileWatchers(link, state, root);
    if (!link.client) {
      state.server = "sign-in";
      return;
    }
    let remote: RemotePersonalEnvironment | null;
    try {
      remote = await link.client.personalEnvironment();
    } catch (cause) {
      this.fail(state, cause);
      return;
    } finally {
      state.lastCheckedAt = new Date(this.now()).toISOString();
    }
    if (!remote) {
      state.server = "unsupported";
      state.remote = null;
      return;
    }
    state.remote = remote;
    state.server = remote.allowed ? "allowed" : "not-allowed";
    try {
      if (!remote.allowed) {
        // Nothing may use it: take back what an earlier Environment allowed.
        if (remote.files.length > 0) {
          await link.client.deletePersonalEnvironment();
          state.remote = await link.client.personalEnvironment();
          state.lastSentFingerprint = null;
        }
        return;
      }
      if (!local.snapshot) return;
      if (
        shouldUpload({
          snapshot: local.snapshot,
          lastSentFingerprint: state.lastSentFingerprint,
          remote,
        })
      ) {
        await link.client.putPersonalEnvironment(
          uploadFromSnapshot(local.snapshot),
        );
        state.lastSentFingerprint = local.snapshot.fingerprint;
        state.lastSyncAt = new Date(this.now()).toISOString();
        state.remote = (await link.client.personalEnvironment()) ?? remote;
      }
    } catch (cause) {
      this.fail(state, cause);
    }
  }

  private fail(state: LinkState, cause: unknown): void {
    if (cause instanceof RemoteAuthError) {
      state.server = "sign-in";
      state.error = null;
      return;
    }
    if (cause instanceof TypeError) {
      state.server = "unreachable";
      state.error = "The project's server could not be reached";
      return;
    }
    state.error = cause instanceof Error ? cause.message : String(cause);
  }

  private state(link: PersonalEnvironmentLink): LinkState {
    const id = linkKey(link.profileId, link.localProjectId);
    let state = this.states.get(id);
    if (!state) {
      state = {
        lastSentFingerprint: null,
        lastSyncAt: null,
        lastCheckedAt: null,
        server: "unknown",
        remote: null,
        config: { exists: false, error: null, config: null },
        files: [],
        error: null,
        running: null,
        again: false,
        statusText: null,
        configFingerprint: null,
        localFingerprint: null,
        watchers: new Map(),
        debounce: null,
      };
      this.states.set(id, state);
    }
    return state;
  }

  private render(
    projectId: string,
    state: LinkState | undefined,
    syncing: boolean,
  ): PersonalEnvironmentView {
    const config = state?.config.config ?? null;
    const remoteFiles = new Map(
      (state?.remote?.files ?? []).map((file) => [file.path, file]),
    );
    const localFiles = new Map(
      (state?.files ?? []).map((file) => [file.path, file]),
    );
    return {
      projectId,
      configPath: PERSONAL_ENVIRONMENT_PATH,
      configExists: state?.config.exists ?? false,
      configError: state?.config.error ?? null,
      server: state?.server ?? "unknown",
      files: (config?.files ?? []).map((filePath) => {
        const local = localFiles.get(filePath);
        const remote = remoteFiles.get(filePath);
        return {
          path: filePath,
          bytes: local?.bytes ?? null,
          problem: local?.problem ?? null,
          server: remote
            ? { bytes: remote.bytes, updatedAt: remote.updatedAt }
            : null,
        };
      }),
      lastSyncAt: state?.lastSyncAt ?? null,
      lastCheckedAt: state?.lastCheckedAt ?? null,
      error: state?.error ?? null,
      syncing,
    };
  }

  /** What agents read to check status: never contents. */
  private async writeStatus(root: string, state: LinkState): Promise<void> {
    if (this.deps.writeStatusFile === false) return;
    const view = this.render("", state, false);
    const status = {
      server: view.server,
      lastSyncAt: view.lastSyncAt,
      error: view.error,
      configError: view.configError,
      files: view.files.map((file) => ({
        path: file.path,
        bytes: file.bytes,
        problem: file.problem,
        onServer: file.server !== null,
      })),
    };
    const text = `${JSON.stringify(status, null, 2)}\n`;
    if (text === state.statusText) return;
    try {
      await ensurePersonalFilesExcluded({ repoPath: root });
      const target = path.join(root, PERSONAL_ENVIRONMENT_STATUS_PATH);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, text, { mode: 0o600 });
      state.statusText = text;
    } catch {
      // Status is a convenience; the next run writes it again.
    }
  }

  /**
   * Watches the config's folder and each listed file's folder (editors
   * replace files by rename, which a per-file watch would miss).
   */
  private reconcileWatchers(
    link: PersonalEnvironmentLink,
    state: LinkState,
    root: string,
  ): void {
    if (this.deps.watchFiles === false || this.stopped) return;
    const configFile = path.join(root, PERSONAL_ENVIRONMENT_PATH);
    const names = new Map<string, Set<string>>();
    const add = (file: string) => {
      const dir = path.dirname(file);
      const set = names.get(dir) ?? new Set<string>();
      set.add(path.basename(file));
      names.set(dir, set);
    };
    add(configFile);
    for (const file of state.config.config?.files ?? [])
      add(path.join(root, file));
    for (const [dir, entry] of state.watchers)
      if (!names.has(dir)) {
        entry.watcher.close();
        state.watchers.delete(dir);
      }
    for (const [dir, files] of names) {
      const signature = [...files].sort().join("\u0000");
      const existing = state.watchers.get(dir);
      if (existing?.names === signature) continue;
      existing?.watcher.close();
      state.watchers.delete(dir);
      try {
        const watcher = watch(dir, { persistent: false }, (_event, name) => {
          if (name && !files.has(path.basename(String(name)))) return;
          if (state.debounce) clearTimeout(state.debounce);
          state.debounce = setTimeout(() => {
            state.debounce = null;
            // The link as it is now: the project may have been reconnected
            // to another server, or disconnected, since this watch began.
            const current = this.link({
              profileId: link.profileId,
              projectId: link.localProjectId,
            });
            if (current) void this.sync(current).catch(() => {});
          }, 750);
        });
        watcher.on("error", () => {
          watcher.close();
          state.watchers.delete(dir);
        });
        state.watchers.set(dir, { names: signature, watcher });
      } catch {
        // The folder does not exist yet; the local check notices it later.
      }
    }
  }

  private emit(link: PersonalEnvironmentLink): void {
    for (const listener of this.listeners)
      listener({ profileId: link.profileId, projectId: link.localProjectId });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

function linkKey(profileId: string, projectId: string): string {
  return `${profileId}\u0000${projectId}`;
}
