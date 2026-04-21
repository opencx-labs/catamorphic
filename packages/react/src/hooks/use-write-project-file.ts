"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCatamorphic } from "../provider.js";

export interface WriteProjectFileInput {
  path: string;
  content: string;
  commitMessage?: string;
}

export interface WrittenProjectFile {
  path: string;
  content: string;
}

function encodeProjectFilePath(filePath: string): string {
  return filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function useWriteProjectFile(projectId: string) {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      input: WriteProjectFileInput,
    ): Promise<WrittenProjectFile> => {
      const url = `${apiClient.baseUrl}/api/projects/${projectId}/files/${encodeProjectFilePath(input.path)}`;
      const res = await apiClient.fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: input.content,
          commitMessage: input.commitMessage,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`PUT ${url} failed: ${res.status} ${text}`);
      }
      return (await res.json()) as WrittenProjectFile;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "files"],
      });
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "file", data.path],
      });
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "workflows"],
      });
    },
  });
}
