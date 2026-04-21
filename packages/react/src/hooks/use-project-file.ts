"use client";

import { useQuery } from "@tanstack/react-query";
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
) {
  const { apiClient } = useCatamorphic();
  return useQuery({
    queryKey: ["cat", "project", projectId, "file", filePath],
    queryFn: async (): Promise<ProjectFileContent> => {
      if (!projectId || !filePath) {
        throw new Error("projectId and filePath are required");
      }
      const url = `${apiClient.baseUrl}/api/projects/${projectId}/files/${encodeProjectFilePath(filePath)}`;
      const res = await apiClient.fetch(url);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`GET ${url} failed: ${res.status} ${text}`);
      }
      return (await res.json()) as ProjectFileContent;
    },
    enabled: Boolean(projectId && filePath),
  });
}
