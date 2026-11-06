"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import {
  assertApiOk,
  CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

/**
 * One connection alias an Environment commits in `.work/project.json` (ADR
 * 0172), with the caller's own and the service authority behind it.
 */
export interface EnvironmentConnectionBinding {
  environment: string;
  alias: string;
  provider: string;
  /** Whose authority the alias accepts. */
  principal: "member" | "service" | "either";
  /** The service connection's name; shown to connection administrators. */
  service: string | null;
  /** What the binding narrows the alias to; null keeps the connection's own. */
  capabilities: string[] | null;
  memberConnection: ConnectionPrincipalStatus | null;
  serviceConnection: ConnectionPrincipalStatus | null;
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
