/**
 * The Work server as a library (ADR 0160). The published image calls
 * `createWorkServer({ config: workServerConfigFromEnv(process.env) })`; a
 * company's own server copies `apps/server/src/index.ts` into its own image
 * and adds hooks (ADRs 0183, 0262: config is typed data, hooks are code).
 */
// What a company's own server file needs (ADR 0262), from one package.
export {
  type ConnectionActionContext,
  type ConnectionActionGuard,
  ConnectionActionRefusedError,
  type ConnectionGuardVerdict,
  type ConnectionProvider,
  type ModelRequest,
  type ModelRequestRewrite,
} from "@catamorphic/core";
export {
  defineGitConnectionProvider,
  defineHttpApiConnectionProvider,
  defineModelConnectionProvider,
  definePostgresConnectionProvider,
} from "@catamorphic/server-sdk";
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
  type ExecutionProbes,
  executionSettingsFromEnv,
  type ResolvedExecutionSettings,
  resolveExecutionSettings,
  type WorkExecutionSettings,
  type WorkSandboxBackend,
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
  lanAddresses,
  type MdnsResponder,
  startMdnsResponder,
} from "./mdns.js";
export {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
  type WorkServerHooks,
  type WorkServerOptions,
} from "./server.js";
export {
  type MachineClass,
  MachineClassSchema,
  type MachinesConfig,
  MachinesConfigSchema,
} from "./workers/machine-classes.js";
export {
  type MachineProvisioner,
  MachineProvisioningRefusedError,
  type MachineRule,
  type ReconcileSummary,
} from "./workers/machine-rules.js";
export {
  listMachineSignIns,
  MachineHeldError,
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
