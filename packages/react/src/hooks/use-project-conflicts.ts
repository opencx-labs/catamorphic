"use client";

import {
  type UseQueryResult,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import type { CatamorphicError } from "../lib/errors.js";
import type { ConflictEntry } from "../types.js";

/**
 * Current merge conflicts for a project.
 *
 * There is no dedicated "list conflicts" endpoint on the server — conflicts
 * are a transient state produced by `deploy` / `pull` mutations. This hook
 * subscribes to a query key that the commit / pull / deploy hooks (and the
 * `useProjectGitState` refactor) populate on conflict-bearing responses.
 * Call `setConflicts` from those callbacks to expose conflicts here; call
 * it with `[]` once resolved.
 */
export function useProjectConflicts(
  projectId: string | undefined,
): UseQueryResult<ConflictEntry[], CatamorphicError> {
  return useQuery<ConflictEntry[], CatamorphicError>({
    queryKey: conflictsKey(projectId),
    queryFn: async () => [],
    enabled: Boolean(projectId),
    staleTime: Number.POSITIVE_INFINITY,
    initialData: [] as ConflictEntry[],
  });
}

export function useSetProjectConflicts(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useCallback(
    (conflicts: ConflictEntry[]) => {
      if (!projectId) return;
      queryClient.setQueryData<ConflictEntry[]>(
        conflictsKey(projectId),
        conflicts,
      );
    },
    [projectId, queryClient],
  );
}

function conflictsKey(projectId: string | undefined): readonly unknown[] {
  return ["cat", "project", projectId, "git", "conflicts"];
}
