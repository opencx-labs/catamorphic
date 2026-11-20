import type { AgentSession, CatamorphicCore } from "@catamorphic/core";
import type {
  CustomizationProcesses,
  CustomizationProcessOwner,
} from "../customization-processes.js";
import type { HarnessDownloadProgress } from "../harness-components.js";
import type { McpAppViews } from "../mcp-app-view-authorization.js";
import type { PersonalEnvironmentSync } from "../personal-environment-sync.js";
import type { RemoteClientRunners } from "../remote-client-runner.js";
import type { DesktopAgentRegistry } from "../server/agent-registry.js";
import type { EmbeddedServer } from "../server/boot.js";
import type { ProjectRoot } from "../server/project-roots.js";
import type { SessionCheckouts } from "../server/session-checkouts.js";
import type { SignInRecovery } from "../server/sign-in-recovery.js";
import type { DesktopTriggers } from "../server/triggers.js";
import type { WorkspaceStateStore } from "../server/workspace-state.js";
import type { SourceHostCall } from "../sidebar-source-ipc.js";
import type { VoiceChat } from "../voice/conversation.js";

/**
 * The methods of `Target` the main process may ask, each answered later:
 * naming one here is what allows it across the channel (ADR 0341). Their
 * arguments and results are data a port can copy.
 */
type Asks<Target, Name extends keyof Target> = {
  [Key in Name]: Target[Key] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Promise<Awaited<Result>>
    : never;
};

type AgentSessions = NonNullable<CatamorphicCore["agentSessions"]>;
type Connections = NonNullable<CatamorphicCore["connections"]>;

/** What a new folder becomes once it is registered. */
export type ProjectCreation =
  | {
      kind: "project";
      name: string;
      importExisting?: boolean;
      empty?: boolean;
    }
  | {
      kind: "repository";
      fullName: string;
      name?: string;
      /**
       * Check the person's GitHub connection reaches the repository first,
       * adopting the GitHub CLI's credential when allowed (ADR 0073).
       */
      ensureAccess?: { allowCli: boolean };
    };

/** A source view's lease as it crosses: its id, and whether it has ended. */
export type CustomizationOwner = Omit<
  CustomizationProcessOwner,
  "viewSignal"
> & { viewClosed?: boolean };

/** A source's call into Work, with its view's lease as data. */
export type CustomizationHostCall = Omit<SourceHostCall, "viewSignal"> & {
  viewClosed?: boolean;
};

/**
 * Everything the main process may ask of the engine (ADR 0341). The engine
 * owns what lasts; this is the whole of what the process that shows it
 * can reach.
 */
export type EngineApi = {
  /** Whether any profile has a usable agent (drives chat affordances). */
  hasCodingAgent(): Promise<boolean>;
  /** Whether approved persistent work needs an engine after the UI quits. */
  hasBackgroundWork(): Promise<boolean>;
  /** Stop the execution worker and release its leases, before OS sleep. */
  suspendExecution(): Promise<void>;
  resumeExecution(): Promise<void>;
  syncSessionMailboxes(): Promise<void>;
  refreshExternalSessions(): Promise<void>;
  /** A relaunch hands working agents back for the next launch (ADR 0246). */
  handBackTurns(): Promise<void>;
  /** HTTP, core, harnesses, then the database once it is quiet. */
  shutdown(): Promise<void>;
  sessionMoveEligibility: EmbeddedServer["sessionMoveEligibility"];
  moveSessionToServer: EmbeddedServer["moveSessionToServer"];
  openRemotePreview: EmbeddedServer["openRemotePreview"];
  returnSessionToProjectFolder: EmbeddedServer["returnSessionToProjectFolder"];

  projectRoots: {
    /**
     * Register a folder as a project, or reopen the project it already is.
     * The folder's row and what it becomes are one operation here: a
     * failed creation takes its registration back.
     */
    register(input: {
      rootPath: string;
      existing: boolean;
      automaticCheckpoints?: boolean;
      create: ProjectCreation;
    }): Promise<{
      id: string;
      name: string;
      /** The folder already was this project: nothing was created. */
      reopened: boolean;
    }>;
    set(projectId: string, rootPath: string): Promise<void>;
    delete(projectId: string): Promise<void>;
  };
  sessionCheckouts: Asks<
    SessionCheckouts,
    | "resolve"
    | "assigned"
    | "detail"
    | "worktreesAvailable"
    | "plan"
    | "bringToProjectFolder"
    | "discard"
  >;
  workspaceStates: Asks<WorkspaceStateStore, "get" | "set" | "delete">;
  agentRegistry: Asks<
    DesktopAgentRegistry,
    | "claudeCodeStatus"
    | "updateInstalledClaudeCode"
    | "ensureHarnessExecutable"
    | "listCommands"
    | "defaultModel"
    | "nativeToolchainEnvironment"
    | "screenNow"
  >;
  signInRecovery: Asks<
    SignInRecovery,
    "signedIn" | "failed" | "left" | "returned" | "probe"
  >;
  triggers: Asks<DesktopTriggers, "onTerminalIdle">;
  clientRunners: Asks<RemoteClientRunners, "connect">;
  personalEnvironment: Asks<
    PersonalEnvironmentSync,
    "view" | "syncNow" | "nudge"
  >;
  customizationProcesses: Asks<
    CustomizationProcesses,
    "recoverProfile" | "inspect"
  > & {
    release(owner: CustomizationOwner): Promise<void>;
    stopByProcessId(input: { processId: string }): Promise<void>;
    /** A view's lease ended: what it started stops being trusted. */
    viewClosed(viewId: string): Promise<void>;
  };
  /** A sidebar source's call into Work, as the person who approved it. */
  customizationHost(call: CustomizationHostCall): Promise<unknown>;
  mcpAppViews: Asks<
    McpAppViews,
    "open" | "call" | "close" | "closeOwner" | "document"
  >;
  /** Chats as the main process needs them: never a snapshot. */
  chats: {
    get(projectId: string, sessionId: string): Promise<AgentSession>;
    /** The chat as voice reads it, reduced where its snapshot lives. */
    voice(
      projectId: string,
      sessionId: string,
    ): Promise<{ session: AgentSession; chat: VoiceChat }>;
    create(
      projectId: string,
      input: { agentId: string; title: string },
    ): Promise<{ id: string }>;
  };
  catamorphic: {
    core: {
      agentDefinitions: Asks<CatamorphicCore["agentDefinitions"], "list">;
      agentSessions: Asks<
        AgentSessions,
        "command" | "interrupt" | "close" | "archiveSubsessionsOnAgent"
      >;
      projects: Asks<
        CatamorphicCore["projects"],
        "get" | "delete" | "commitAll" | "listFiles"
      >;
      codeHosts: Asks<
        CatamorphicCore["codeHosts"],
        | "originConnected"
        | "commentOnPullRequest"
        | "mergePullRequest"
        | "reviewPullRequest"
        | "pullRequestDiscussion"
        | "pullRequest"
        | "pullRequestFiles"
        | "pullRequestStatus"
        | "listPullRequests"
      >;
      connections: Asks<
        Connections,
        | "beginPersonalAuthorization"
        | "completeAuthorization"
        | "cancelAuthorization"
        | "personal"
        | "revoke"
      >;
    };
  };
};

/** What the engine says first: where it listens, and what it holds. */
export interface EngineHello {
  /** The loopback API's address. */
  url: string;
  /** What the app's own windows send so the API tells them from pages. */
  apiToken: string;
  /** The code host the person's GitHub connection is of. */
  githubKind: string;
  /** Every project's folder, and whether it checkpoints by itself. */
  projectRoots: ProjectRoot[];
}

/** What the engine says happened; nobody waits for these. */
export interface EngineEvents {
  /** The mirror of project folders: sent before the answer that caused it. */
  projectRootChanged: ProjectRoot;
  /** This server's chats may have changed (ADR 0229). */
  sessionsChanged: Record<string, never>;
  personalEnvironmentChanged: { profileId: string; projectId: string };
  /** A project's files moved under its windows. */
  gitChanged: { projectId: string };
  harnessDownloadProgress: HarnessDownloadProgress;
  /** The database's thread ended while the engine ran: nothing works. */
  databaseLost: { message: string };
}
