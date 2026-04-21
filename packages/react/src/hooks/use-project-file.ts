"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import {
  CatamorphicError,
  runWithCatamorphicError,
  toCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

function encodeProjectFilePath(filePath: string): string {
  return filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export interface ProjectFileContent {
  path: string;
  content: string;
}

export function useProjectFile(
  projectId: string | undefined,
  filePath: string | undefined,
): UseQueryResult<ProjectFileContent, CatamorphicError> {
  const { apiClient } = useCatamorphic();
  return useQuery<ProjectFileContent, CatamorphicError>({
    queryKey: ["cat", "project", projectId, "file", filePath],
    queryFn: () =>
      runWithCatamorphicError(async () => {
        if (!projectId || !filePath) {
          throw new CatamorphicError({
            code: "validation",
            message: "projectId and filePath are required",
          });
        }
        const url = `${apiClient.baseUrl}/api/projects/${projectId}/files/${encodeProjectFilePath(filePath)}`;
        const res = await apiClient.fetch(url);
        if (!res.ok) {
          const body = await res.json().catch(() => res.text().catch(() => ""));
          throw toCatamorphicError({
            response: res,
            body,
            fallbackMessage: `GET ${url} failed`,
          });
        }
        return (await res.json()) as ProjectFileContent;
      }),
    enabled: Boolean(projectId && filePath),
  });
}
