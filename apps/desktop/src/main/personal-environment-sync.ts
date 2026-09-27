import { type FSWatcher, watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ensurePersonalFilesExcluded } from "@catamorphic/git";
import {
  PERSONAL_HARNESS_LABELS,
  PERSONAL_HARNESSES,
  type PersonalEnvironmentServerState,
  type PersonalEnvironmentView,
  type PersonalHarness,
} from "../shared/personal-environment.js";
import { CLAUDE_REFRESH_WINDOW_MS, type LocalLogin } from "./harness-logins.js";
import {
  type ListedFile,
  PERSONAL_ENVIRONMENT_PATH,
  PERSONAL_ENVIRONMENT_STATUS_PATH,
  type PersonalEnvironmentConfig,
  readListedFiles,
  readPersonalEnvironmentConfig,
  requestedLogins,
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
 * member's own sign-ins and listed files, sent to the Work server when they
 * change, checked on a timer and on focus, and refreshed locally when the
 * server says a copy in use is about to expire. Only this desktop's CLIs
 * ever refresh a login; the server's copy carries no refresh token.
 */

/** How often each linked server is asked about the environment. */
export const REMOTE_CHECK_MS = 2 * 60_000;
/** How often local sign-ins and listed files are compared with what was sent. */
export const LOCAL_CHECK_MS = 30_000;
/** At most one local refresh attempt per harness in this interval. */
export const REFRESH_RETRY_MS = 4 * 60_000;

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
  logins: LocalLogin[];
  files: ListedFile[];
  fingerprint: string;
}

export function snapshotFingerprint(args: {
  logins: readonly LocalLogin[];
  files: readonly ListedFile[];
}): string {
  return sha256(
    JSON.stringify({
      logins: args.logins.map((login) => [login.harness, login.fingerprint]),
      files: args.files.flatMap((file) =>
        file.fingerprint ? [[file.path, file.fingerprint]] : [],
      ),
    }),
  );
}

export function uploadFromSnapshot(
  snapshot: PersonalEnvironmentSnapshot,
): RemotePersonalEnvironmentUpload {
  const logins: RemotePersonalEnvironmentUpload["logins"] = {};
  for (const login of snapshot.logins) {
    const expiresAt = login.expiresAt ? { expiresAt: login.expiresAt } : {};
    if (login.harness === "claude-code")
      logins["claude-code"] = { credentials: login.payload, ...expiresAt };
    else logins.codex = { auth: login.payload, ...expiresAt };
  }
  return {
    logins,
    files: snapshot.files.flatMap((file) =>
      file.content
        ? [{ path: file.path, content: file.content.toString("base64") }]
        : [],
    ),
  };
}

export type LoginRefreshDecision =
  /** The server does not need a fresher copy. */
  | "none"
  /** The local login is already fresher than the server's copy. */
  | "send"
  /** Ask the local CLI to refresh, then send. */
  | "refresh"
  /** Claude Code will not refresh yet; check again later. */
  | "wait";

/** What to do about one login the server asked to have refreshed. */
export function loginRefreshDecision(args: {
  harness: PersonalHarness;
  local: Pick<LocalLogin, "expiresAt"> | null;
  remote: RemotePersonalEnvironment["logins"][PersonalHarness];
  now: number;
}): LoginRefreshDecision {
  if (!args.remote?.needsRefresh || !args.local) return "none";
  const localMs = args.local.expiresAt ? Date.parse(args.local.expiresAt) : NaN;
  const remoteMs = args.remote.expiresAt
    ? Date.parse(args.remote.expiresAt)
    : NaN;
  if (Number.isFinite(localMs) && !(localMs <= remoteMs)) return "send";
  if (args.harness === "codex") return "refresh";
  if (!Number.isFinite(localMs)) return "refresh";
  return localMs - args.now <= CLAUDE_REFRESH_WINDOW_MS ? "refresh" : "wait";
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
  const remoteLogins = PERSONAL_HARNESSES.filter(
    (harness) => args.remote.logins[harness],
  );
  const localLogins = PERSONAL_HARNESSES.filter((harness) =>
    args.snapshot.logins.some((login) => login.harness === harness),
  );
  if (remoteLogins.join() !== localLogins.join()) return true;
  for (const login of args.snapshot.logins) {
    const remote = args.remote.logins[login.harness];
    if (
      login.expiresAt &&
      remote?.expiresAt &&
      Date.parse(login.expiresAt) !== Date.parse(remote.expiresAt)
    )
      return true;
  }
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
  available: Partial<Record<PersonalHarness, LocalLogin>>;
  files: ListedFile[];
  error: string | null;
  running: Promise<void> | null;
  again: boolean;
  statusText: string | null;
  configFingerprint: string | null;
  /** Watched folder to the file names that matter in it. */
  watchers: Map<string, { names: string; watcher: FSWatcher }>;
  debounce: NodeJS.Timeout | null;
}

export interface PersonalEnvironmentSyncDeps {
  links(): PersonalEnvironmentLink[];
  projectRoot(projectId: string): Promise<string | null>;
  readLogin(harness: PersonalHarness): Promise<LocalLogin | null>;
  refreshLogin(harness: PersonalHarness): Promise<void>;
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
  private readonly refreshAttempts = new Map<PersonalHarness, number>();
  private readonly refreshes = new Map<PersonalHarness, Promise<void>>();
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
    await Promise.all(
      this.deps.links().map((link) => this.sync(link).catch(() => {})),
    );
  }

  /** Current view, starting a check when this link was never checked. */
  view(args: { profileId: string; projectId: string }): PersonalEnvironmentView {
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
    return this.render(args.projectId, this.states.get(linkKey(args.profileId, args.projectId)), false);
  }

  private async checkLocal(): Promise<void> {
    for (const link of this.deps.links()) {
      const state = this.states.get(linkKey(link.profileId, link.localProjectId));
      if (state?.server !== "allowed" || state.running) continue;
      const root = await this.deps.projectRoot(link.localProjectId);
      if (!root) continue;
      try {
        const local = await this.collect(root);
        if (
          local.configFingerprint !== state.configFingerprint ||
          local.snapshot?.fingerprint !== state.lastSentFingerprint
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
          await this.run(link, state);
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
    available: Partial<Record<PersonalHarness, LocalLogin>>;
    files: ListedFile[];
    snapshot: PersonalEnvironmentSnapshot | null;
  }> {
    const file = await readPersonalEnvironmentConfig({ root });
    const available: Partial<Record<PersonalHarness, LocalLogin>> = {};
    for (const harness of PERSONAL_HARNESSES) {
      const login = await this.deps.readLogin(harness);
      if (login) available[harness] = login;
    }
    if (!file.parsed.ok)
      return {
        configFingerprint: file.fingerprint,
        config: null,
        exists: file.exists,
        error: file.parsed.error,
        available,
        files: [],
        snapshot: null,
      };
    const config = file.parsed.config;
    const logins = requestedLogins({
      config,
      available: PERSONAL_HARNESSES.filter((harness) => available[harness]),
    }).flatMap((harness) => {
      const login = available[harness];
      return login ? [login] : [];
    });
    const files = await readListedFiles({ root, files: config.files });
    return {
      configFingerprint: file.fingerprint,
      config,
      exists: file.exists,
      error: null,
      available,
      files,
      snapshot: { logins, files, fingerprint: snapshotFingerprint({ logins, files }) },
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
    let local = await this.collect(root);
    state.configFingerprint = local.configFingerprint;
    state.config = {
      exists: local.exists,
      error: local.error,
      config: local.config,
    };
    state.available = local.available;
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
        if (
          Object.keys(remote.logins).length > 0 ||
          remote.files.length > 0
        ) {
          await link.client.deletePersonalEnvironment();
          state.remote = await link.client.personalEnvironment();
          state.lastSentFingerprint = null;
        }
        return;
      }
      if (!local.snapshot) return;
      const refreshed = await this.refreshWhereNeeded(local.snapshot, remote);
      if (refreshed) {
        local = await this.collect(root);
        state.available = local.available;
        state.files = local.files;
        if (!local.snapshot) return;
      }
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
    } finally {
      await this.writeStatus(root, state);
    }
  }

  /** Refreshes logins the server needs fresher; true when any changed. */
  private async refreshWhereNeeded(
    snapshot: PersonalEnvironmentSnapshot,
    remote: RemotePersonalEnvironment,
  ): Promise<boolean> {
    let changed = false;
    for (const login of snapshot.logins) {
      const decision = loginRefreshDecision({
        harness: login.harness,
        local: login,
        remote: remote.logins[login.harness],
        now: this.now(),
      });
      if (decision !== "refresh") continue;
      const last = this.refreshAttempts.get(login.harness) ?? 0;
      if (this.now() - last < REFRESH_RETRY_MS) continue;
      this.refreshAttempts.set(login.harness, this.now());
      const pending =
        this.refreshes.get(login.harness) ??
        this.deps.refreshLogin(login.harness).finally(() => {
          this.refreshes.delete(login.harness);
        });
      this.refreshes.set(login.harness, pending);
      try {
        await pending;
        const after = await this.deps.readLogin(login.harness);
        if (after && after.fingerprint !== login.fingerprint) changed = true;
      } catch (cause) {
        console.warn(
          `[desktop] could not refresh the ${PERSONAL_HARNESS_LABELS[login.harness]} sign-in:`,
          cause instanceof Error ? cause.message : "unknown error",
        );
      }
    }
    return changed;
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
        available: {},
        files: [],
        error: null,
        running: null,
        again: false,
        statusText: null,
        configFingerprint: null,
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
    const wanted = config?.logins ?? PERSONAL_HARNESSES;
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
      logins: PERSONAL_HARNESSES.map((harness) => {
        const local = state?.available[harness];
        const remote = state?.remote?.logins[harness];
        return {
          harness,
          label: PERSONAL_HARNESS_LABELS[harness],
          included: wanted.includes(harness),
          available: Boolean(local),
          expiresAt: local?.expiresAt ?? null,
          server: remote
            ? {
                expiresAt: remote.expiresAt ?? null,
                updatedAt: remote.updatedAt,
                needsRefresh: remote.needsRefresh,
              }
            : null,
        };
      }),
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

  /** What agents read to check status: never contents or credentials. */
  private async writeStatus(root: string, state: LinkState): Promise<void> {
    if (this.deps.writeStatusFile === false) return;
    const view = this.render("", state, false);
    const status = {
      server: view.server,
      lastSyncAt: view.lastSyncAt,
      error: view.error,
      configError: view.configError,
      logins: view.logins.map((login) => ({
        login: login.harness,
        included: login.included,
        signedInHere: login.available,
        expiresAt: login.expiresAt,
        onServer: login.server !== null,
        needsRefresh: login.server?.needsRefresh ?? false,
      })),
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
            void this.sync(link).catch(() => {});
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
