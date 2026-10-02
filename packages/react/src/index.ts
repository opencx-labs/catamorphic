// Provider

export type {
  AgentAttachment,
  AgentMediaAttachment,
  AgentQuestion,
  AgentQuestionOption,
  AgentTextAttachment,
  AgentTextSource,
  AgentTodo,
  AgentTurnUsage,
  AssistantMessageItem,
  Attempt,
  CommandItem,
  CommandReceipt,
  ContextHandoffItem,
  FileChangeItem,
  Item,
  ItemKind,
  ItemStatus,
  JsonObject,
  JsonValue,
  NoticeItem,
  PlanItem,
  ReasoningItem,
  RequestItem,
  RuntimeRequest,
  RuntimeRequestResponse,
  SessionCommand,
  SessionMessageAuthor,
  SessionSnapshot,
  SessionState,
  StoredSessionEvent,
  SubagentItem,
  ToolCallItem,
  Turn,
  TurnStatus,
  UserMessageItem,
} from "@catamorphic/agent-protocol";
// The session model every chat client renders (ADR 0196), re-exported so a
// copied registry component needs only this package.
export {
  activeTurn,
  commandActivity,
  isActiveTurnStatus,
  isSettledTurnStatus,
  isWorking,
  itemActivity,
  itemsOfTurn,
  orderedTurns,
  pendingRequests,
  queuedTurns,
} from "@catamorphic/agent-protocol";
// The marker helpers live beside the harness renderers in the sandbox
// package (its browser-safe subpath) so pills mean the same on both sides.
export {
  ATTACHMENT_MARKER,
  messageWithAttachmentNames,
} from "@catamorphic/sandbox/attachments";
// Atoms
export {
  codeAtom,
  codeEditorReadOnlyAtom,
  collapsedNodeIdsAtom,
  executionStateAtom,
  graphAtom,
  graphParseStateAtom,
  lastTriggerDataAtom,
  reactFlowEdgesAtom,
  reactFlowNodesAtom,
  selectedNodeAtom,
  selectedNodeIdAtom,
  showRunDialogAtom,
} from "./atoms.js";
export { useAcknowledgeAgentSessionAttention } from "./hooks/use-acknowledge-agent-session-attention.js";
export {
  type AgentCatalog,
  useAgentCatalog,
} from "./hooks/use-agent-catalog.js";
export {
  type AgentAuthenticationRequired,
  type AgentChatAttachment,
  authenticationRequiredFrom,
  type PendingAgentMessage,
  type SendOptions,
  turnActivity,
  type UseAgentChatOptions,
  type UseAgentChatResult,
  useAgentChat,
} from "./hooks/use-agent-chat.js";
export {
  type AgentSessionConnection,
  type AgentSessionData,
  type AgentSessionInfo,
  agentSessionQueryKey,
  reconnectDelayMs,
  type UseAgentSessionOptions,
  type UseAgentSessionResult,
  useAgentSession,
} from "./hooks/use-agent-session.js";
// Agent (Track A)
export {
  type AgentSessionsList,
  type UseAgentSessionsOptions,
  useAgentAttention,
  useAgentSessions,
} from "./hooks/use-agent-sessions.js";
export { useAppPresentations } from "./hooks/use-app-presentations.js";
export {
  type ArchiveAgentSessionInput,
  type ArchiveAgentSessionResult,
  useArchiveAgentSession,
  useUnarchiveAgentSession,
} from "./hooks/use-archive-agent-session.js";
export {
  type AttachPluginInput,
  useAttachPlugin,
} from "./hooks/use-attach-plugin.js";
export {
  type AuthorizationChallenge,
  useAuthorizeConnection,
} from "./hooks/use-authorize-connection.js";
export type {
  CodeEditorRevealRequest,
  UseCodeEditorLinkResult,
} from "./hooks/use-code-editor-link.js";
export { useCodeEditorLink } from "./hooks/use-code-editor-link.js";
export {
  type CodeHostRepositorySummary,
  type CodeHostSummary,
  type ImportRepositoryInput,
  useCodeHostRepositories,
  useCodeHosts,
  useImportRepository,
} from "./hooks/use-code-hosts.js";
export {
  type CommitChangesInput,
  useCommitChanges,
} from "./hooks/use-commit-changes.js";
export { useCompleteConnectionAuthorization } from "./hooks/use-complete-connection-authorization.js";
export { useConnectionAuthorizationStatus } from "./hooks/use-connection-authorization-status.js";
export {
  type CreateAgentSessionInput,
  useCreateAgentSession,
} from "./hooks/use-create-agent-session.js";
export {
  type CreateProjectInput,
  useCreateProject,
} from "./hooks/use-create-project.js";
export { useDeleteProject } from "./hooks/use-delete-project.js";
export {
  type DeleteSecretInput,
  useDeleteProjectSecret,
} from "./hooks/use-delete-project-secret.js";
export {
  type DeployProjectInput,
  useDeployProject,
} from "./hooks/use-deploy-project.js";
export {
  type DetachPluginInput,
  useDetachPlugin,
} from "./hooks/use-detach-plugin.js";
export { useEditorKeyboard } from "./hooks/use-editor-keyboard.js";
export {
  type EnvironmentConnectionBinding,
  useEnvironmentConnections,
} from "./hooks/use-environment-connections.js";
export {
  type EnvironmentList,
  useEnvironments,
} from "./hooks/use-environments.js";
export {
  type ForkAgentSessionInput,
  useForkAgentSession,
} from "./hooks/use-fork-agent-session.js";
export { type UseOnParseOptions, useOnParse } from "./hooks/use-on-parse.js";
export type {
  ParseWorkflowRequest,
  ParseWorkflowResponse,
} from "./hooks/use-parse-workflow.js";
export { useParseWorkflow } from "./hooks/use-parse-workflow.js";
// Plugins (Track A)
export { usePluginCatalog } from "./hooks/use-plugin-catalog.js";
export { useProject } from "./hooks/use-project.js";
export {
  type UseProjectCommitsOptions,
  useProjectCommits,
} from "./hooks/use-project-commits.js";
export {
  useProjectConflicts,
  useSetProjectConflicts,
} from "./hooks/use-project-conflicts.js";
export {
  type ProjectFileContent,
  useProjectFile,
} from "./hooks/use-project-file.js";
// File hooks
export { useProjectFiles } from "./hooks/use-project-files.js";
// Git (Track A)
export {
  type UseProjectGitOptions,
  useProjectGit,
} from "./hooks/use-project-git.js";
// Phase-2 hook (re-homed but still accepts a host-injected git api adapter)
export type {
  CommitInfo,
  ConflictEntry,
  ProjectGitApi,
  ProjectGitState,
  RepoStatus,
  UseProjectGitStateOptions,
} from "./hooks/use-project-git-state.js";
export { useProjectGitState } from "./hooks/use-project-git-state.js";
export { useProjectPlugins } from "./hooks/use-project-plugins.js";
// Secrets (Track A)
export { useProjectSecrets } from "./hooks/use-project-secrets.js";
export { type UseProjectsOptions, useProjects } from "./hooks/use-projects.js";
// Runs
export {
  runKeys,
  type UseKeyedRunMutationOptions,
  type UseRunItemStepsOptions,
  type UseRunItemsOptions,
  type UseRunMutationOptions,
  type UseRunOptions,
  type UseRunsOptions,
  type UseSubmitRunInputOptions,
  type UseTriggerRunOptions,
  useCancelRun,
  useCancelRunByKey,
  usePauseRunProcessing,
  useResumeRunProcessing,
  useRun,
  useRunItemSteps,
  useRunItems,
  useRuns,
  useSignalRun,
  useSubmitRunInput,
  useTriggerRun,
} from "./hooks/use-runs.js";
export { useSelectedNode } from "./hooks/use-selected-node.js";
export { useSessionArtifacts } from "./hooks/use-session-artifacts.js";
export {
  type UpdateAgentSessionInput,
  useUpdateAgentSession,
} from "./hooks/use-update-agent-session.js";
export {
  type UpdateProjectInput,
  useUpdateProject,
} from "./hooks/use-update-project.js";
export {
  type UpsertSecretInput,
  useUpsertProjectSecret,
} from "./hooks/use-upsert-project-secret.js";
export { useWatchers, watcherKeys } from "./hooks/use-watchers.js";
export {
  useRotateWebhook,
  useWebhooks,
  type Webhook,
  webhookKeys,
} from "./hooks/use-webhooks.js";
export {
  type UseWorkflowOptions,
  useWorkflow,
} from "./hooks/use-workflow.js";
export {
  useCreateWorkflowEnablement,
  usePreviewWorkflowEnablement,
  useUpdateWorkflowEnablement,
  useWorkflowEnablements,
  type WorkflowEnablement,
  type WorkflowEnablementInput,
  type WorkflowEnablementList,
  type WorkflowEnablementPreview,
  workflowEnablementKeys,
} from "./hooks/use-workflow-enablements.js";
// Canvas / graph state
export type {
  OnParseCallback,
  ParseResult,
} from "./hooks/use-workflow-graph.js";
export { useWorkflowGraph } from "./hooks/use-workflow-graph.js";
// Workflow hooks
export {
  type UseWorkflowsOptions,
  useWorkflows,
} from "./hooks/use-workflows.js";
export {
  useWriteProjectFile,
  type WriteProjectFileInput,
  type WrittenProjectFile,
} from "./hooks/use-write-project-file.js";
export type { WorkflowGraph } from "./lib/api-types.js";
export type {
  CatamorphicErrorCode,
  CatamorphicErrorInit,
  ToCatamorphicErrorInput,
} from "./lib/errors.js";
export {
  assertApiOk,
  CatamorphicError,
  runWithCatamorphicError,
  toCatamorphicError,
} from "./lib/errors.js";
// Lib helpers (bidirectional code ↔ canvas linking)
export type { EditorPosition } from "./lib/find-node-at-position.js";
export { findNodeAtPosition } from "./lib/find-node-at-position.js";
// Lib helpers (workflow code authoring)
export type { WorkflowDefinition } from "./lib/find-workflow-definitions.js";
export { findWorkflowDefinitions } from "./lib/find-workflow-definitions.js";
export {
  matchWorkflowNodes,
  workflowNodeKeys,
} from "./lib/match-workflow-nodes.js";
export type { ResourcePreview } from "./lib/resource-preview.js";
export {
  type SessionCommandInput,
  sendSessionCommand,
} from "./lib/session-commands.js";
export {
  AGENT_SESSION_PROTOCOL,
  readSessionStream,
  SESSION_PROTOCOL_MISMATCH_MESSAGE,
  speaksSessionProtocol,
} from "./lib/session-stream.js";
export {
  answerRows,
  itemText,
  QUESTIONS_DISMISSED_MESSAGE,
  type QueuedMessage,
  sessionQueue,
  sessionTimeline,
  startingTurn,
  type TimelineEntry,
  type TimelineTurn,
  type WorkItem,
  waitsToRun,
} from "./lib/session-timeline.js";
export {
  buildUntitledWorkflowName,
  displayNameFromWorkflowName,
  ensurePrimaryWorkflowExportName,
  readWorkflowDisplayName,
  starterCodeForWorkflow,
  upsertWorkflowDisplayName,
  workflowFilePathFromName,
} from "./lib/workflow-helpers.js";
export type {
  CatamorphicContextValue,
  CatamorphicProviderProps,
} from "./provider.js";
export {
  CatamorphicProvider,
  useCatamorphic,
  useQueryClient,
} from "./provider.js";
// Shared domain types (also available as subpath import `@catamorphic/react/types`)
export type {
  AgentSession,
  AgentSessionDetail,
  AttachedPlugin,
  BatchProgress,
  CancelRunByKeyInput,
  CancelRunInput,
  CommitsList,
  DeployResult,
  DiffEntry,
  FilesAtRef,
  PluginAttachment,
  PluginInfo,
  PluginSecretDescriptor,
  PullResult,
  Run,
  RunCapabilities,
  RunDetail,
  RunItem,
  RunItemStatus,
  RunItemStep,
  RunItemsList,
  RunPause,
  RunPhase,
  RunStatus,
  RunStep,
  RunsList,
  Secret,
  SecretStatus,
  SignalRunInput,
  SubmitRunInput,
  TriggeredRun,
  TriggerRunInput,
  Watcher,
  WorkflowCapabilities,
  WorkflowStepAttempt,
} from "./types.js";
export { workflowKeys } from "./workflow-keys.js";
