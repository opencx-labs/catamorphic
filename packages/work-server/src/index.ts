/**
 * The Work server as a library (ADR 0160). The published image calls
 * `createWorkServer({ config: workServerConfigFromEnv(process.env) })`; a
 * custom server passes the same config plus its hooks.
 */
export {
  isSecurePublicUrl,
  type WorkAgentEffort,
  type WorkAgentSettings,
  type WorkServerConfig,
  workServerConfigFromEnv,
} from "./config.js";
export {
  executionSettingsFromEnv,
  type WorkExecutionSettings,
} from "./execution-config.js";
export type { AccountStanding } from "./identity/account-lifecycle.js";
export {
  type DirectoryAccountStatus,
  type DirectoryInactiveReason,
  type DirectoryProvider,
  DirectoryUnavailableError,
} from "./identity/directory.js";
export {
  type GoogleDirectoryCredentials,
  GoogleWorkspaceDirectory,
} from "./identity/google-directory.js";
export {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
  type WorkServerHooks,
  type WorkServerOptions,
} from "./server.js";
export {
  startWorkWorker,
  type WorkWorkerOptions,
} from "./workers/worker-runtime.js";
