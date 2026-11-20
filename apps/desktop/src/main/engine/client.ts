import type { CustomizationProcessOwner } from "../customization-processes.js";
import type { HarnessDownloadProgress } from "../harness-components.js";
import type { ProjectRoot } from "../server/project-roots.js";
import type { SourceHostCall } from "../sidebar-source-ipc.js";
import type { EngineApi, EngineEvents, EngineHello } from "./api.js";
import { type ChannelClientPort, connectChannel } from "./channel.js";

/** Operations the main process only tells: nobody waits for their answer. */
type Tells<Operations> = {
  [Name in keyof Operations]: Operations[Name] extends (
    ...args: infer Args
  ) => unknown
    ? (...args: Args) => void
    : never;
};

/**
 * The engine as the main process holds it (ADR 0341): operations it asks
 * over the channel, a copy of what it must read without waiting, and what
 * the engine says happened. Nothing here is the server's own object.
 */
export interface Engine
  extends Omit<
    EngineApi,
    | "suspendExecution"
    | "resumeExecution"
    | "syncSessionMailboxes"
    | "refreshExternalSessions"
    | "projectRoots"
    | "agentRegistry"
    | "signInRecovery"
    | "triggers"
    | "personalEnvironment"
    | "customizationProcesses"
    | "customizationHost"
    | "mcpAppViews"
  > {
  /** The loopback API's address. */
  readonly url: string;
  /** What the app's own windows send so the API tells them from pages. */
  readonly apiToken: string;
  readonly github: { readonly kind: string };

  /** Sent at once: the operating system does not wait for it either. */
  suspendExecution(): void;
  resumeExecution(): void;
  syncSessionMailboxes(): void;
  refreshExternalSessions(): void;

  projectRoots: EngineApi["projectRoots"] & {
    /** From the copy the engine keeps current: no message is sent. */
    get(projectId: string): Promise<string | null>;
    getSync(projectId: string): string | undefined;
    checkpointsEnabled(projectId: string): boolean;
  };
  agentRegistry: EngineApi["agentRegistry"] & {
    /** First-use harness downloads, so sign-in UI can show real progress. */
    onHarnessDownloadProgress(
      listener: (progress: HarnessDownloadProgress) => void,
    ): () => void;
  };
  signInRecovery: Tells<EngineApi["signInRecovery"]>;
  triggers: Tells<EngineApi["triggers"]>;
  personalEnvironment: Pick<
    EngineApi["personalEnvironment"],
    "view" | "syncNow"
  > & {
    nudge(): void;
    subscribe(
      listener: (change: { profileId: string; projectId: string }) => void,
    ): () => void;
  };
  customizationProcesses: Pick<
    EngineApi["customizationProcesses"],
    "recoverProfile" | "inspect" | "stopByProcessId"
  > & {
    release(owner: CustomizationProcessOwner): Promise<void>;
  };
  /** A sidebar source's call into Work, as the person who approved it. */
  customizationHost(call: SourceHostCall): Promise<unknown>;
  mcpAppViews: Pick<EngineApi["mcpAppViews"], "open" | "call" | "document"> &
    Tells<Pick<EngineApi["mcpAppViews"], "close" | "closeOwner">>;

  /** This server's chats may have changed (ADR 0229). */
  onSessionsChanged(listener: () => void): () => void;
  /** A project's files moved under its windows. */
  onGitChanged(listener: (projectId: string) => void): () => void;
  /**
   * The engine's database stopped while it ran. Whoever listens hears of
   * a loss that came before they did.
   */
  onDatabaseLost(listener: (error: Error) => void): () => void;
  /**
   * Ask the engine to shut down and end the channel. What was asked before
   * is answered first; what is asked after is refused.
   */
  shutdown(): Promise<void>;
}

/**
 * A copy of the engine's project folders, seeded from what it said first
 * and changed by what it says after: each change arrives before the answer
 * to the request that made it.
 */
function projectRootsMirror() {
  const roots = new Map<string, ProjectRoot>();
  const apply = (change: ProjectRoot) => {
    if (change.rootPath === null) roots.delete(change.projectId);
    else roots.set(change.projectId, change);
  };
  return {
    seed(entries: readonly ProjectRoot[]) {
      roots.clear();
      for (const entry of entries) apply(entry);
    },
    apply,
    getSync: (projectId: string) => roots.get(projectId)?.rootPath ?? undefined,
    checkpointsEnabled: (projectId: string) =>
      roots.get(projectId)?.automaticCheckpoints ?? false,
  };
}

/**
 * The main process's end of the engine's channel: connect, and wait for
 * the engine to say it is ready. `lost` reports the engine going away
 * unasked and `stop` ends the transport, as for any channel.
 */
export async function connectEngine({
  port,
  lost,
  stop,
  onLost,
}: {
  port: ChannelClientPort<EngineEvents, EngineHello>;
  lost: (listener: (error: Error) => void) => void;
  stop: () => Promise<unknown> | unknown;
  onLost?: (error: Error) => void;
}): Promise<Engine> {
  // Heard from the moment the channel is connected: the copy is seeded
  // before any change to it, and a loss is kept for whoever listens later.
  const mirror = projectRootsMirror();
  let databaseLost: Error | undefined;
  const lostListeners = new Set<(error: Error) => void>();
  const channel = connectChannel<EngineApi, EngineEvents, EngineHello>({
    port,
    lost,
    stop,
    ...(onLost ? { onLost } : {}),
    greeted: (hello) => mirror.seed(hello.projectRoots),
  });
  channel.on("projectRootChanged", mirror.apply);
  channel.on("databaseLost", ({ message }) => {
    if (databaseLost) return;
    databaseLost = new Error(message);
    for (const listener of [...lostListeners]) listener(databaseLost);
  });
  const { api, hello } = await channel.ready;

  /** A message nobody waits for: its failure is noted, never thrown. */
  const tell = (what: string, answered: Promise<unknown>) => {
    void answered.catch((error: unknown) => {
      // Nothing is left to tell once the engine is closed.
      if (channel.closed) return;
      console.warn(
        `[desktop] The engine was not told '${what}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  };

  /** A view's lease crosses as its id; its end is told once. */
  const told = new WeakSet<AbortSignal>();
  const leased = <Owner extends { viewId?: string; viewSignal?: AbortSignal }>({
    viewSignal,
    ...owner
  }: Owner) => {
    const viewId = owner.viewId;
    if (viewSignal && viewId && !viewSignal.aborted && !told.has(viewSignal)) {
      told.add(viewSignal);
      viewSignal.addEventListener(
        "abort",
        () =>
          tell(
            "customizationProcesses.viewClosed",
            api.customizationProcesses.viewClosed(viewId),
          ),
        { once: true },
      );
    }
    return { ...owner, ...(viewSignal?.aborted ? { viewClosed: true } : {}) };
  };

  let shuttingDown: Promise<void> | undefined;

  return {
    url: hello.url,
    apiToken: hello.apiToken,
    github: { kind: hello.githubKind },

    hasCodingAgent: api.hasCodingAgent,
    hasBackgroundWork: api.hasBackgroundWork,
    handBackTurns: api.handBackTurns,
    sessionMoveEligibility: api.sessionMoveEligibility,
    moveSessionToServer: api.moveSessionToServer,
    openRemotePreview: api.openRemotePreview,
    returnSessionToProjectFolder: api.returnSessionToProjectFolder,
    suspendExecution: () => tell("suspendExecution", api.suspendExecution()),
    resumeExecution: () => tell("resumeExecution", api.resumeExecution()),
    syncSessionMailboxes: () =>
      tell("syncSessionMailboxes", api.syncSessionMailboxes()),
    refreshExternalSessions: () =>
      tell("refreshExternalSessions", api.refreshExternalSessions()),

    projectRoots: {
      ...api.projectRoots,
      get: async (projectId) => mirror.getSync(projectId) ?? null,
      getSync: mirror.getSync,
      checkpointsEnabled: mirror.checkpointsEnabled,
    },
    sessionCheckouts: api.sessionCheckouts,
    workspaceStates: api.workspaceStates,
    agentRegistry: {
      ...api.agentRegistry,
      onHarnessDownloadProgress: (listener) =>
        channel.on("harnessDownloadProgress", listener),
    },
    signInRecovery: {
      signedIn: (...args) =>
        tell("signInRecovery.signedIn", api.signInRecovery.signedIn(...args)),
      failed: (...args) =>
        tell("signInRecovery.failed", api.signInRecovery.failed(...args)),
      left: () => tell("signInRecovery.left", api.signInRecovery.left()),
      returned: () =>
        tell("signInRecovery.returned", api.signInRecovery.returned()),
      probe: () => tell("signInRecovery.probe", api.signInRecovery.probe()),
    },
    triggers: {
      onTerminalIdle: (...args) =>
        tell("triggers.onTerminalIdle", api.triggers.onTerminalIdle(...args)),
    },
    clientRunners: api.clientRunners,
    personalEnvironment: {
      view: api.personalEnvironment.view,
      syncNow: api.personalEnvironment.syncNow,
      nudge: () =>
        tell("personalEnvironment.nudge", api.personalEnvironment.nudge()),
      subscribe: (listener) =>
        channel.on("personalEnvironmentChanged", listener),
    },
    customizationProcesses: {
      recoverProfile: api.customizationProcesses.recoverProfile,
      inspect: api.customizationProcesses.inspect,
      stopByProcessId: api.customizationProcesses.stopByProcessId,
      release: (owner) => api.customizationProcesses.release(leased(owner)),
    },
    customizationHost: (call) => api.customizationHost(leased(call)),
    mcpAppViews: {
      open: api.mcpAppViews.open,
      call: api.mcpAppViews.call,
      document: api.mcpAppViews.document,
      close: (...args) =>
        tell("mcpAppViews.close", api.mcpAppViews.close(...args)),
      closeOwner: (...args) =>
        tell("mcpAppViews.closeOwner", api.mcpAppViews.closeOwner(...args)),
    },
    chats: api.chats,
    catamorphic: api.catamorphic,

    onSessionsChanged: (listener) =>
      channel.on("sessionsChanged", () => listener()),
    onGitChanged: (listener) =>
      channel.on("gitChanged", ({ projectId }) => listener(projectId)),
    onDatabaseLost: (listener) => {
      lostListeners.add(listener);
      if (databaseLost) listener(databaseLost);
      return () => {
        lostListeners.delete(listener);
      };
    },
    shutdown: () => {
      shuttingDown ??= (async () => {
        try {
          await api.shutdown();
        } finally {
          await channel.close();
        }
      })();
      return shuttingDown;
    },
  };
}

/** What a window needs to reach the engine's API, or that it cannot yet. */
export async function engineInfo(
  engine: Engine | null,
): Promise<{ url: string | null; hasCodingAgent: boolean }> {
  if (!engine) return { url: null, hasCodingAgent: false };
  return {
    url: engine.url,
    hasCodingAgent: await engine.hasCodingAgent().catch(() => false),
  };
}
