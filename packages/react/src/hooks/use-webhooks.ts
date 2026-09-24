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

export type Webhook =
  paths["/api/projects/{projectId}/webhooks"]["get"]["responses"][200]["content"]["application/json"][number];

export const webhookKeys = {
  list: (projectId: string) =>
    ["cat", "project", projectId, "webhooks"] as const,
};

/** The project's webhook URLs (`webhooks:read`): each URL is a credential. */
export function useWebhooks(
  projectId: string | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<Webhook[], CatamorphicError> {
  const { apiClient } = useCatamorphic();
  return useQuery({
    queryKey: webhookKeys.list(projectId ?? ""),
    enabled: Boolean(projectId) && options.enabled !== false,
    queryFn: () =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.GET(
          "/api/projects/{projectId}/webhooks",
          { params: { path: { projectId: projectId ?? "" } } },
        );
        return assertApiOk(result, "Webhooks could not be loaded");
      }),
  });
}

/** Issue a new URL for a webhook; the old one stops working at once. */
export function useRotateWebhook(
  projectId: string,
): UseMutationResult<Webhook, CatamorphicError, { name: string }> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name }) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.POST(
          "/api/projects/{projectId}/webhooks/{name}/rotate",
          { params: { path: { projectId, name } } },
        );
        return assertApiOk(result, "Webhook URL could not be replaced");
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: webhookKeys.list(projectId) }),
  });
}
