import { MessageChannel } from "node:worker_threads";
import type { ConnectionProvider } from "@catamorphic/core";
import type { WorkspaceBridge } from "../agent-bridge.js";
import type { CodeApprovals } from "../code-approvals.js";
import type { ConnectorsService } from "../connectors.js";
import type { IncognitoSessionsStore } from "../incognito-sessions.js";
import type { McpAppsService } from "../mcp-apps.js";
import type { ProfileConfigManager } from "../profile-config.js";
import type { ProfilesStore } from "../profiles.js";
import type { EmbeddedServerHost } from "../server/boot.js";
import type { DataPaths } from "../server/paths.js";
import type { EngineEvents, EngineHello } from "./api.js";
import { serveChannel } from "./channel.js";
import { connectEngine, type Engine } from "./client.js";

/** What the engine is started with. */
export interface EngineStart {
  paths: DataPaths;
  profiles: ProfilesStore;
  profileConfig: ProfileConfigManager;
  approvalsFor: (profileId: string) => CodeApprovals;
  workspaceBridge?: WorkspaceBridge;
  connectors?: ConnectorsService;
  mcpApps?: McpAppsService;
  incognitoSessions?: IncognitoSessionsStore;
  connectionProviders?: readonly ConnectionProvider[];
  /** The profile of the window a guest document's owner is in. */
  ownerProfile?: (ownerId: number) => string | undefined;
  /**
   * What the server asks of whoever shows the app. A lost database and
   * moved files are the engine's to say, as events on its channel.
   */
  host?: Omit<EmbeddedServerHost, "databaseLost" | "gitChanged">;
}

/**
 * Start the engine and return the main process's hold on it (ADR 0341).
 *
 * The engine still runs in this process: the server boots here, and what
 * it is handed are this process's own objects. The main process reaches it
 * only through the channel all the same, over a real port, so anything
 * that is not data fails to cross today; moving the engine to a process
 * of its own then changes where this function finds the port's far end.
 */
export async function startEngine(start: EngineStart): Promise<Engine> {
  // Let the shell start loading before the server's modules are evaluated.
  const [{ startEmbeddedServer }, { engineService }] = await Promise.all([
    import("../server/boot.js"),
    import("./service.js"),
  ]);
  // What the server says before its channel is served waits for it.
  const unsent: Array<() => void> = [];
  let send: ReturnType<typeof serveChannel<EngineEvents, EngineHello>>["emit"] =
    (name, payload) => {
      unsent.push(() => send(name, payload));
    };
  const emit: typeof send = (name, payload) => send(name, payload);

  const server = await startEmbeddedServer(
    start.paths,
    start.profiles,
    start.profileConfig,
    start.approvalsFor,
    start.workspaceBridge,
    start.connectors,
    start.mcpApps,
    start.incognitoSessions,
    start.connectionProviders,
    start.ownerProfile,
    {
      ...start.host,
      databaseLost: (error) => emit("databaseLost", { message: error.message }),
      gitChanged: (projectId) => emit("gitChanged", { projectId }),
    },
  );
  const service = engineService({ server, emit });
  const { port1, port2 } = new MessageChannel();
  const served = serveChannel<EngineEvents, EngineHello>({
    port: port2,
    api: service.api,
    hello: service.hello,
  });
  send = served.emit;
  for (const event of unsent.splice(0)) event();
  return connectEngine({
    port: port1,
    // Both ends live and end together until the engine is its own process.
    lost: () => {},
    stop: () => {
      service.dispose();
      port1.close();
      port2.close();
    },
  });
}
