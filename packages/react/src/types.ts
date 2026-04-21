/**
 * Shared OpenAPI-derived domain types. Hooks, registry components, and host
 * apps all import these from `@catamorphic/react/types` so a copy-pasted
 * registry component still typechecks against the canonical definition.
 *
 * Each alias indexes directly into the OpenAPI `paths` map rather than
 * hiding behind a generic helper — conditional helpers collapse to
 * `any`/`never` once TypeScript emits `.d.ts`.
 */

import type { paths } from "@catamorphic/api-client";

// Re-export primitives from api-types.ts so this barrel is the one place
// consumers need to import from.
export type {
  CreatedProject,
  DeletedProject,
  ParseWorkflowRequest,
  ParseWorkflowResponse,
  Project,
  ProjectFilesList,
  ProjectsList,
  Template,
  UpdatedProject,
  WorkflowGraph,
  WorkflowList,
} from "./lib/api-types.js";

import type { ProjectsList } from "./lib/api-types.js";

/** Slim project shape returned by the list endpoint (no `workflows`/`files`). */
export type ProjectSummary = ProjectsList["items"][number];

/** Single entry returned by the project files list endpoint. */
export type ProjectFileEntry =
  paths["/api/projects/{projectId}/files"]["get"]["responses"][200]["content"]["application/json"][number];

// --- Runs ---------------------------------------------------------------

/** Single run as returned by the list endpoint (no `steps`). */
export type Run =
  paths["/api/projects/{projectId}/workflows/{name}/runs"]["get"]["responses"][200]["content"]["application/json"]["items"][number];

export type RunsList =
  paths["/api/projects/{projectId}/workflows/{name}/runs"]["get"]["responses"][200]["content"]["application/json"];

/** Run detail including `steps`. */
export type RunDetail =
  paths["/api/runs/{runId}"]["get"]["responses"][200]["content"]["application/json"];

export type RunStep = RunDetail["steps"][number];

export type TriggerRunInput =
  paths["/api/projects/{projectId}/workflows/{name}/runs"]["post"]["requestBody"]["content"]["application/json"];

export type TriggeredRun =
  paths["/api/projects/{projectId}/workflows/{name}/runs"]["post"]["responses"][201]["content"]["application/json"];

// --- Git ----------------------------------------------------------------

export type RepoStatus =
  paths["/api/projects/{projectId}/status"]["get"]["responses"][200]["content"]["application/json"];

export type BranchInfo =
  paths["/api/projects/{projectId}/branches"]["get"]["responses"][200]["content"]["application/json"][number];

export type CreatedBranch =
  paths["/api/projects/{projectId}/branches"]["post"]["responses"][200]["content"]["application/json"];

export type CommitInfo =
  paths["/api/projects/{projectId}/commits"]["get"]["responses"][200]["content"]["application/json"]["items"][number];

export type CommitsList =
  paths["/api/projects/{projectId}/commits"]["get"]["responses"][200]["content"]["application/json"];

export type DeployResult =
  paths["/api/projects/{projectId}/deploy"]["post"]["responses"][200]["content"]["application/json"];

export type ConflictEntry = DeployResult["conflicts"][number];

export type PullResult =
  paths["/api/projects/{projectId}/pull"]["post"]["responses"][200]["content"]["application/json"];

export type DiffEntry =
  paths["/api/projects/{projectId}/workdir"]["get"]["responses"][200]["content"]["application/json"][number];

export type FilesAtRef =
  paths["/api/projects/{projectId}/files-at-ref"]["get"]["responses"][200]["content"]["application/json"];

// --- Plugins ------------------------------------------------------------

export type PluginInfo =
  paths["/api/plugins/catalog"]["get"]["responses"][200]["content"]["application/json"][number];

export type AttachedPlugin =
  paths["/api/projects/{projectId}/plugins"]["post"]["responses"][201]["content"]["application/json"];

export type PluginAttachment = AttachedPlugin;

export type PluginSecretDescriptor = PluginInfo["secrets"][number];

// --- Secrets ------------------------------------------------------------

export type Secret =
  paths["/api/projects/{projectId}/secrets"]["get"]["responses"][200]["content"]["application/json"][number];

export type SecretStatus = Secret;

// --- Agent sessions -----------------------------------------------------

export type AgentSession =
  paths["/api/projects/{projectId}/agent/sessions"]["get"]["responses"][200]["content"]["application/json"]["items"][number];

export type AgentSessionDetail =
  paths["/api/projects/{projectId}/agent/sessions/{sessionId}"]["get"]["responses"][200]["content"]["application/json"];

export type AgentMessage = AgentSessionDetail["messages"][number];

export type SentAgentMessage =
  paths["/api/projects/{projectId}/agent/sessions/{sessionId}/messages"]["post"]["responses"][201]["content"]["application/json"];
