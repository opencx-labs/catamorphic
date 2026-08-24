"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import {
  assertApiOk,
  CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

export interface EnvironmentConnectionBinding {
  id: string;
  projectId: string;
  environment: string;
  alias: string;
  providerKind: string;
  principalKinds: Array<"member" | "project_service" | "tenant_service">;
  serviceConnectionId: string | null;
  capabilities: string[];
  memberConnection: ConnectionPrincipalStatus | null;
  serviceConnection: ConnectionPrincipalStatus | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionPrincipalStatus {
  connectionId: string | null;
  principalKind: "member" | "project_service" | "tenant_service";
  label: string;
  status: "pending" | "ready" | "expired" | "revoked";
  account: unknown;
  scopes: string[];
}

export function useEnvironmentConnections(
  projectId: string | undefined,
  environment: string | undefined,
): UseQueryResult<EnvironmentConnectionBinding[], CatamorphicError> {
  const { apiClient } = useCatamorphic();
  return useQuery({
    queryKey: [
      "cat",
      "project",
      projectId,
      "environment",
      environment,
      "connections",
    ],
    queryFn: () =>
      runWithCatamorphicError(async () => {
        if (!projectId || !environment) {
          throw new CatamorphicError({
            code: "validation",
            message: "projectId and environment are required",
          });
        }
        const result = await apiClient.GET(
          "/api/projects/{projectId}/environments/{environment}/connections",
          { params: { path: { projectId, environment } } },
        );
        return assertApiOk(result, "Connections could not be loaded");
      }),
    enabled: Boolean(projectId && environment),
  });
}
