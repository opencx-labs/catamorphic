"use client";

import {
  type ProjectGitApi,
  type UseProjectGitStateOptions,
  useProjectGitState as useProjectGitStateBase,
} from "@catamorphic/react";
import { api } from "./api";

/**
 * Playground adapter that wires the headless git hook from @catamorphic/react
 * to the playground's ad-hoc REST client. Once these endpoints land in the
 * typed openapi schema we can drop this wrapper and have the host hook call
 * the api-client directly.
 */
const playgroundGitApi: ProjectGitApi = {
  getStatus: (projectId) => api.getStatus(projectId),
  getBranches: (projectId) => api.getBranches(projectId),
  getCommits: (projectId) => api.getCommits(projectId),
  getFilesAtRef: (projectId, ref) => api.getFilesAtRef(projectId, ref),
  deploy: (projectId, body) => api.deploy(projectId, body),
  pull: (projectId, body) => api.pull(projectId, body),
  discard: (projectId) => api.discard(projectId),
  resolveConflicts: (projectId, body) => api.resolveConflicts(projectId, body),
};

export type { ProjectGitState } from "@catamorphic/react";

export function useProjectGitState(
  options: Omit<UseProjectGitStateOptions, "api">,
) {
  return useProjectGitStateBase({ ...options, api: playgroundGitApi });
}
