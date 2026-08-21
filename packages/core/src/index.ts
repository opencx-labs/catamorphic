export {
  appApiTypesPath,
  checkProject,
  HOLE_SCHEMA_KEY,
  renderAppApiTypesModule,
  validateAgainstSchema,
} from "@catamorphic/parser";
export type { CatamorphicCoreConfig } from "./core.js";
export { CatamorphicCore, createCatamorphicCore } from "./core.js";
export {
  type AgentRef,
  type AgentRefToolPolicy,
  type AppRef,
  type ArtifactRef,
  authorFor,
  type DocumentRef,
  documentRefCovers,
  type ExternalUserId,
  type Identity,
  identityCovers,
  isBuilder,
  isScoped,
  mayUseProject,
  narrowIdentity,
  type ProjectRef,
  SYSTEM_AUTHOR,
  sameArtifact,
  scopeCovers,
  type TenantId,
  type WorkflowRef,
} from "./identity.js";
export {
  appScaffold,
  HOST_SKILLS,
  PROJECT_CHECK_SCRIPT,
  PROJECT_CHECK_SCRIPT_PATH,
  SEED_SKILLS,
  workspaceFiles,
} from "./seeds.js";
export { AgentContextService } from "./services/agent-context-service.js";
export {
  AGENT_DEFINITION_KINDS,
  AGENT_DEFINITIONS_DIR,
  type AgentDefinition,
  type AgentDefinitionCredentials,
  AgentDefinitionCredentialsSchema,
  type AgentDefinitionKind,
  AgentDefinitionSchema,
  AgentDefinitionsService,
  agentDefinitionSchema,
  definitionHash,
  formatProjectAgentId,
  PROJECT_AGENT_ID_PREFIX,
  type ProjectAgentEntry,
  parseProjectAgentId,
  projectAgentId,
  validateAgentDefinition,
} from "./services/agent-definitions-service.js";
export {
  type AgentMessage,
  AgentNotConfiguredError,
  type AgentSession,
  AgentSessionClosedError,
  type AgentSessionDetail,
  AgentSessionNotFoundError,
  AgentSessionsService,
  AgentTurnInProgressError,
  type AgentTurnSettledEvent,
  SessionMirrorDivergedError,
  type SyncedFileChange,
} from "./services/agent-sessions-service.js";
export type { AppBundleStore } from "./services/app-bundle-store.js";
export { appBundleKey, appVersionPrefix } from "./services/app-bundle-store.js";
export {
  AppLimitExceededError,
  AppPoliciesService,
  AppsDisabledError,
  type TenantAppPolicy,
  type UpsertTenantAppPolicyInput,
} from "./services/app-policies-service.js";
export {
  AppStorageService,
  AppStorageSnapshotTooLargeError,
} from "./services/app-storage-service.js";
export {
  AppBuildFailedError,
  type AppBundle,
  AppBundleTooLargeError,
  AppContractError,
  AppNotFoundError,
  AppPublishStateError,
  type AppSummary,
  AppsService,
  type AppVersion,
  type AppVersionKind,
  AppVersionNotFoundError,
  type AppVersionStatus,
} from "./services/apps-service.js";
export {
  AccessDeniedError,
  assertBuilder,
  assertRootIdentity,
  assertScopeAllowsWorkflow,
  type ResolvedScope,
  resolveScope,
} from "./services/artifact-scope.js";
export {
  type CapabilityContext,
  type CapabilityProviderRuntime,
  CapabilityRegistry,
  CapabilityResolutionError,
  DuplicateCapabilityProviderError,
  type HostCallContext,
  type HostCallFunction,
  HostCallNotFoundError,
  ReservedCapabilityEnvError,
  UnfulfilledCapabilityError,
} from "./services/capability-providers.js";
export type {
  CodeHost,
  PullRequestFile,
  PullRequestSummary,
} from "./services/code-host.js";
export {
  type AgentExecutionMode,
  type CodingAgentRegistry,
  isCodingAgentRegistry,
  type RegisteredCodingAgent,
  singleAgentRegistry,
} from "./services/coding-agent-registry.js";
export { DbSandboxStore } from "./services/db-sandbox-store.js";
export {
  createDeploymentArtifactIdentity,
  type DeploymentArtifact,
  type DeploymentArtifactIdentity,
  type DeploymentArtifactStatus,
  DeploymentArtifactsService,
} from "./services/deployment-artifacts-service.js";
export {
  type DeploymentRuntimeCleanupResult,
  type DeploymentRuntimeHealthResult,
  DeploymentRuntimeNotSupportedError,
  type DeploymentRuntimeRetirementResult,
  DeploymentRuntimeService,
} from "./services/deployment-runtime-service.js";
export {
  type DeploymentRuntimeRecord,
  type DeploymentRuntimeRecordStatus,
  type DeploymentRuntimeStore,
  KyselyDeploymentRuntimeStore,
} from "./services/deployment-runtime-store.js";
export { DeploymentService } from "./services/deployment-service.js";
export {
  DevSandboxService,
  type PreparedDevSandbox,
} from "./services/dev-sandbox-service.js";
export {
  contentTypeFor,
  type DocumentBlobStore,
  DocumentConflictError,
  type DocumentContent,
  type DocumentEntry,
  type DocumentMatch,
  DocumentNotFoundError,
  DocumentPathError,
  type DocumentSource,
  DocumentsService,
  DocumentTooLargeError,
  type DocumentVersion,
  documentAccessAllowed,
  isStorePath,
  normalizeDocumentPath,
  STORE_ROOT,
} from "./services/documents-service.js";
export {
  type ExecutionJob,
  type ExecutionJobKind,
  type ExecutionJobStatus,
  ExecutionJobsService,
} from "./services/execution-jobs-service.js";
export {
  ExecutionJobDeferredError,
  type ExecutionJobHandler,
  type ExecutionWorkerHandle,
  type ExecutionWorkerOptions,
  ExecutionWorkerService,
} from "./services/execution-worker-service.js";
export {
  type GithubConnectionStatus,
  GithubNotConnectedError,
  GithubService,
  type GithubServiceConfig,
  GithubTokenExpiredError,
  type ImportGithubRepoInput,
  ProjectNotLinkedToGithubError,
} from "./services/github-service.js";
export { executeHostCall, type HostCallInput } from "./services/host-calls.js";
export {
  type GrantMembershipInput,
  type Membership,
  MembershipsService,
} from "./services/memberships-service.js";
export {
  type AttachedPluginInfo,
  type PluginInfo,
  PluginNotAttachedError,
  PluginsService,
  UndeclaredSecretError,
} from "./services/plugins-service.js";
export { forgetProgramFetch } from "./services/program-reader.js";
export {
  type CreateProjectInput,
  type ListProjectsInput,
  type ListProjectsResult,
  type Project,
  ProjectDeprovisioningError,
  type ProjectFileEntry,
  ProjectFileNotFoundError,
  type ProjectLifecycleHooks,
  ProjectNotFoundError,
  ProjectProvisioningError,
  ProjectsService,
  requireTenantProject,
  type UpdateProjectInput,
  type WriteFileInput,
} from "./services/projects-service.js";
export {
  mayPropose,
  type ProposalResult,
  ProposalsService,
  ProposalsUnsupportedError,
  type ProposedChange,
  type ProposeInput,
  proposalBranch,
} from "./services/proposals-service.js";
export {
  type Publication,
  type PublicationAudience,
  PublicationNotFoundError,
  PublicationSlugError,
  PublicationSlugTakenError,
  PublicationsService,
} from "./services/publications-service.js";
export {
  type BlockedRateReservation,
  type GrantedRateReservation,
  type RateBucketKey,
  type RateLimit,
  type RateReservationResult,
  RateReservationsService,
} from "./services/rate-reservations-service.js";
export {
  ProjectHasNoRemoteError,
  PullRequestsUnsupportedError,
  type RemoteSyncOutcome,
  RemoteSyncService,
} from "./services/remote-sync-service.js";
export {
  DEFAULT_RUN_RETENTION_DAYS,
  type PurgeResult,
  type RetentionConfig,
  RetentionService,
} from "./services/retention-service.js";
export {
  expandRole,
  fillTemplate,
  type ProjectRoleEntry,
  type ResolveRolesInput,
  ROLES_DIR,
  type RoleDefinition,
  RoleDefinitionSchema,
  type RoleGrants,
  RolesService,
  resolveRoles,
  validateRoleDefinition,
} from "./services/roles-service.js";
export {
  RunPauseNotFoundError,
  RunResumeConflictError,
} from "./services/run-coordinator.js";
export {
  type RunPluginBundle,
  RunPluginsLoader,
} from "./services/run-plugins-loader.js";
export {
  type BatchItem,
  type BatchItemStatus,
  type BatchItemStep,
  type BatchProgress,
  type CallRunInput,
  type CancelRunInput,
  type EnrollmentConflictPolicy,
  type GetRunInput,
  type ListBatchItemStepsInput,
  type ListBatchItemsInput,
  type ListBatchItemsResult,
  type ListRunsInput,
  type ListRunsResult,
  type PauseRunInput,
  PluginSecretsMissingError,
  ProductionDeploymentNotFoundError,
  type RedriveRunJobInput,
  type ResumeRunInput,
  type ResumeRunPauseInput,
  type Run,
  type RunArtifact,
  type RunCallOutcome,
  type RunCapabilities,
  RunCapabilityError,
  type RunDetail,
  RunEnrollmentConflictError,
  RunInputInvalidError,
  RunNotFoundError,
  type RunPause,
  type RunPhase,
  type RunProvenance,
  RunSignalNotFoundError,
  type RunStatus,
  type RunStep,
  type RunSuspensionReason,
  RunsService,
  SandboxProviderNotConfiguredError,
  type StepStatus,
  type TriggerProductionRunInput,
  type WorkflowStepAttempt,
  type WorkflowStepAttemptStatus,
} from "./services/runs-service.js";
export {
  type SecretEnvironment,
  type SecretStatus,
  SecretsService,
} from "./services/secrets-service.js";
export {
  humanizeSkillName,
  type ProjectSkill,
  parseSkillFrontmatter,
  SKILLS_DIR,
  SkillsService,
} from "./services/skills-service.js";
export {
  documentsClientFor,
  type LocalStatus,
  localStatus,
  MANIFEST_PATH,
  type RemoteDocumentEntry,
  type RemoteDocumentsClient,
  type RemoteDocumentVersion,
  type ShipReport,
  STORE_PREFIX,
  type SyncReport,
  serverCopyPath,
  shipRemoteProject,
  syncRemoteProject,
} from "./services/store-sync.js";
export {
  TenantActiveRunLimitError,
  type TenantExecutionPolicy,
  TenantPoliciesService,
  type TenantRateLimitOverride,
  type UpsertTenantExecutionPolicyInput,
} from "./services/tenant-policies-service.js";
export {
  type PendingToolPermission,
  ToolPermissionBroker,
} from "./services/tool-permission-broker.js";
export {
  renderTriggerTypesModule,
  TRIGGER_TYPES_SOURCE_PATH,
} from "./services/trigger-codegen.js";
export {
  buildTriggerKindRegistry,
  MCP_POLL_RUN_TOOL,
  type McpToolKindSpec,
  type McpToolMetadata,
  type TriggerKindDisplay,
  type TriggerKindInfo,
  type TriggerKindRuntime,
  type TriggerMode,
  type TriggerValidationResult,
  triggerKindInfo,
} from "./services/trigger-kinds.js";
export {
  type TriggerBindingInfo,
  TriggerBindingsInvalidError,
  type TriggerFireOutcome,
  type TriggerFireResult,
  TriggerKindNotRegisteredError,
  TriggerModeNotAllowedError,
  TriggerPayloadInvalidError,
  type TriggerSuspensionReason,
  TriggersService,
} from "./services/triggers-service.js";
export {
  type WorkflowDetail,
  WorkflowNotFoundError,
  type WorkflowSummary,
  WorkflowsService,
} from "./services/workflows-service.js";
