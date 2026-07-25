"use client";

import {
  type UseMutationResult,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type CatamorphicError,
  runWithCatamorphicError,
  toCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";
import { workflowKeys } from "../workflow-keys.js";

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

export function useWriteProjectFile(
  projectId: string,
): UseMutationResult<
  WrittenProjectFile,
  CatamorphicError,
  WriteProjectFileInput
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();

  return useMutation<
    WrittenProjectFile,
    CatamorphicError,
    WriteProjectFileInput
  >({
    mutationFn: (input) =>
      runWithCatamorphicError(async () => {
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
          const body = await res.json().catch(() => res.text().catch(() => ""));
          throw toCatamorphicError({
            response: res,
            body,
            fallbackMessage: `PUT ${url} failed`,
          });
        }
        return (await res.json()) as WrittenProjectFile;
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "files"],
      });
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "file", data.path],
      });
      queryClient.invalidateQueries({
        queryKey: workflowKeys.project({ projectId }),
      });
    },
  });
}
