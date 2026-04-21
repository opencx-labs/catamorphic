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
export {
  type CreateProjectInput,
  useCreateProject,
} from "./hooks/use-create-project.js";
export { useDeleteProject } from "./hooks/use-delete-project.js";
export type {
  ParseWorkflowRequest,
  ParseWorkflowResponse,
} from "./hooks/use-parse-workflow.js";
export { useParseWorkflow } from "./hooks/use-parse-workflow.js";
export { useProject } from "./hooks/use-project.js";
export {
  type ProjectFileContent,
  useProjectFile,
} from "./hooks/use-project-file.js";
// File hooks
export { useProjectFiles } from "./hooks/use-project-files.js";
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
export { type UseProjectsOptions, useProjects } from "./hooks/use-projects.js";
export { useSelectedNode } from "./hooks/use-selected-node.js";
// Project hooks
export { useTemplates } from "./hooks/use-templates.js";
export {
  type UpdateProjectInput,
  useUpdateProject,
} from "./hooks/use-update-project.js";
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
