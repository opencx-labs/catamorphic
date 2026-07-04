// Provider

// Atoms
export type {
  HistoryTab,
  LoadMoreRunsFn,
  PanelTab,
  PanelVisibility,
} from "./atoms.js";
export {
  activeHistoryTabAtom,
  activePanelTabAtom,
  activeRunIdAtom,
  aiLoadingAtom,
  codeAtom,
  codeEditorReadOnlyAtom,
  executionStateAtom,
  graphAtom,
  historySidebarOpenAtom,
  isRunningAtom,
  lastTriggerDataAtom,
  loadMoreRunsAtom,
  panelVisibilityAtom,
  reactFlowEdgesAtom,
  reactFlowNodesAtom,
  rightPanelOpenAtom,
  runsAtom,
  selectedNodeAtom,
  selectedNodeIdAtom,
  showRunDialogAtom,
} from "./atoms.js";
export { useAgentSession } from "./hooks/use-agent-session.js";
// Agent (Track A)
export {
  type AgentSessionsList,
  type UseAgentSessionsOptions,
  useAgentSessions,
} from "./hooks/use-agent-sessions.js";
export {
  type AttachPluginInput,
  useAttachPlugin,
} from "./hooks/use-attach-plugin.js";
export { useCancelWorkflowRun } from "./hooks/use-cancel-workflow-run.js";
export { useCheckoutBranch } from "./hooks/use-checkout-branch.js";
export type {
  CodeEditorRevealRequest,
  UseCodeEditorLinkResult,
} from "./hooks/use-code-editor-link.js";
export { useCodeEditorLink } from "./hooks/use-code-editor-link.js";
export {
  type CommitChangesInput,
  useCommitChanges,
} from "./hooks/use-commit-changes.js";
export {
  type CreateAgentSessionInput,
  useCreateAgentSession,
} from "./hooks/use-create-agent-session.js";
export {
  type CreateBranchInput,
  useCreateBranch,
} from "./hooks/use-create-branch.js";
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
export { type UseOnParseOptions, useOnParse } from "./hooks/use-on-parse.js";
export type {
  ParseWorkflowRequest,
  ParseWorkflowResponse,
} from "./hooks/use-parse-workflow.js";
export { useParseWorkflow } from "./hooks/use-parse-workflow.js";
// Plugins (Track A)
export { usePluginCatalog } from "./hooks/use-plugin-catalog.js";
export { useProject } from "./hooks/use-project.js";
export { useProjectBranches } from "./hooks/use-project-branches.js";
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
  BranchInfo,
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
export { useSelectedNode } from "./hooks/use-selected-node.js";
export {
  type SendAgentMessageInput,
  useSendAgentMessage,
} from "./hooks/use-send-agent-message.js";
// Project hooks
export { useTemplates } from "./hooks/use-templates.js";
export { useTriggerWorkflowRun } from "./hooks/use-trigger-workflow-run.js";
export {
  type UpdateProjectInput,
  useUpdateProject,
} from "./hooks/use-update-project.js";
export {
  type UpsertSecretInput,
  useUpsertProjectSecret,
} from "./hooks/use-upsert-project-secret.js";
export {
  type UseWorkflowOptions,
  useWorkflow,
} from "./hooks/use-workflow.js";
// Canvas / graph state
export type {
  OnParseCallback,
  ParseResult,
} from "./hooks/use-workflow-graph.js";
export { useWorkflowGraph } from "./hooks/use-workflow-graph.js";
// Runs (Track A)
export { useWorkflowRun } from "./hooks/use-workflow-run.js";
export type {
  TriggerRunFn,
  TriggerRunResult,
  UseWorkflowRunControllerOptions,
  UseWorkflowRunControllerResult,
} from "./hooks/use-workflow-run-controller.js";
export { useWorkflowRunController } from "./hooks/use-workflow-run-controller.js";
export {
  type UseWorkflowRunsOptions,
  useWorkflowRuns,
} from "./hooks/use-workflow-runs.js";
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
// Run types (shared between hooks and ui)
export type { PlaygroundRun, PlaygroundRunStep } from "./run-types.js";
// Shared domain types (also available as subpath import `@catamorphic/react/types`)
export type {
  AgentMessage,
  AgentSession,
  AgentSessionDetail,
  AttachedPlugin,
  CommitsList,
  CreatedBranch,
  DeployResult,
  DiffEntry,
  FilesAtRef,
  PluginAttachment,
  PluginInfo,
  PluginSecretDescriptor,
  PullResult,
  Run,
  RunDetail,
  RunStep,
  RunsList,
  Secret,
  SecretStatus,
  SentAgentMessage,
  TriggeredRun,
  TriggerRunInput,
} from "./types.js";
