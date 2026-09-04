"use client";

import type { paths } from "@catamorphic/api-client";
import {
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  assertApiOk,
  type CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

type ListResponse =
  paths["/api/projects/{projectId}/workflow-enablements"]["get"]["responses"][200]["content"]["application/json"];
export type WorkflowEnablement = ListResponse[number];
export type WorkflowEnablementPreview =
  paths["/api/projects/{projectId}/workflow-enablement-preview"]["post"]["responses"][200]["content"]["application/json"];
export type WorkflowEnablementInput =
  paths["/api/projects/{projectId}/workflow-enablement-preview"]["post"]["requestBody"]["content"]["application/json"];

export const workflowEnablementKeys = {
  project: (projectId: string) =>
    ["cat", "project", projectId, "workflow-enablement"] as const,
  list: (projectId: string, workflowName?: string) =>
    [...workflowEnablementKeys.project(projectId), { workflowName }] as const,
};

export function useWorkflowEnablements(
  projectId: string | undefined,
  workflowName?: string,
): UseQueryResult<WorkflowEnablement[], CatamorphicError> {
  const { apiClient } = useCatamorphic();
  return useQuery({
    queryKey: workflowEnablementKeys.list(projectId ?? "", workflowName),
    enabled: Boolean(projectId),
    queryFn: () =>
      runWithCatamorphicError(async () => {
        if (!projectId) throw new Error("projectId is required");
        const result = await apiClient.GET(
          "/api/projects/{projectId}/workflow-enablements",
          {
            params: {
              path: { projectId },
              query: workflowName ? { workflowName } : {},
            },
          },
        );
        return assertApiOk(result, "Workflow enablements could not be loaded");
      }),
  });
}

export function usePreviewWorkflowEnablement(
  projectId: string,
): UseMutationResult<
  WorkflowEnablementPreview,
  CatamorphicError,
  WorkflowEnablementInput
> {
  const { apiClient } = useCatamorphic();
  return useMutation({
    mutationFn: (body) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.POST(
          "/api/projects/{projectId}/workflow-enablement-preview",
          { params: { path: { projectId } }, body },
        );
        return assertApiOk(result, "Workflow enablement could not be prepared");
      }),
  });
}

export function useCreateWorkflowEnablement(
  projectId: string,
): UseMutationResult<
  WorkflowEnablement,
  CatamorphicError,
  WorkflowEnablementInput & { consentDigest: string }
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.POST(
          "/api/projects/{projectId}/workflow-enablements",
          { params: { path: { projectId } }, body },
        );
        return assertApiOk(result, "Workflow could not be enabled");
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: workflowEnablementKeys.project(projectId),
      }),
  });
}

export function useUpdateWorkflowEnablement(
  projectId: string,
): UseMutationResult<
  WorkflowEnablement,
  CatamorphicError,
  {
    enablementId: string;
    action: "disable" | "reenable" | "update-deployment";
    consentDigest?: string;
  }
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) =>
      runWithCatamorphicError(async () => {
        const params = {
          path: { projectId, enablementId: input.enablementId },
        };
        const result =
          input.action === "disable"
            ? await apiClient.POST(
                "/api/projects/{projectId}/workflow-enablements/{enablementId}/disable",
                { params },
              )
            : input.action === "reenable"
              ? await apiClient.POST(
                  "/api/projects/{projectId}/workflow-enablements/{enablementId}/reenable",
                  { params },
                )
              : await apiClient.POST(
                  "/api/projects/{projectId}/workflow-enablements/{enablementId}/update-deployment",
                  {
                    params,
                    body: { consentDigest: input.consentDigest ?? "" },
                  },
                );
        return assertApiOk(result, "Workflow enablement could not be updated");
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: workflowEnablementKeys.project(projectId),
      }),
  });
}
