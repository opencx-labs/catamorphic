/**
 * The Work server as a library (ADR 0160). The published image calls
 * `createWorkServer({ config: workServerConfigFromEnv(process.env) })`; a
 * custom server passes the same config, or builds it in code, plus its hooks
 * (ADR 0183: config is typed data, hooks are code).
 */
export type {
  ConnectionActionContext,
  ConnectionActionGuard,
  ConnectionGuardVerdict,
} from "@catamorphic/core";
export {
  type WorkAuthConfig,
  WorkAuthConfigSchema,
} from "./auth/auth-config.js";
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
export {
  type GatewayConfig,
  GatewayConfigSchema,
  type GatewayConnectionConfig,
} from "./gateway/gateway-config.js";
export type { AccountStanding } from "./identity/account-lifecycle.js";
export {
  type DirectoryAccountStatus,
  type DirectoryInactiveReason,
  type DirectoryProvider,
  DirectoryUnavailableError,
} from "./identity/directory.js";
export {
  type GoogleDirectoryCredentials,
  type GoogleServiceAccountKey,
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
  listMachineSignIns,
  type MachineSignIn,
  signInOnMachine,
  signInRoot,
  signOutOnMachine,
} from "./workers/sign-ins.js";
export {
  WORKER_PROTOCOL,
  WORKER_PROTOCOL_HEADER,
} from "./workers/worker-protocol.js";
export {
  startWorkWorker,
  WorkerUpgradeRequiredError,
  type WorkWorkerOptions,
} from "./workers/worker-runtime.js";
