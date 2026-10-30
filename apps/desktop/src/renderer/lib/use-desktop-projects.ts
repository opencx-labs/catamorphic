import {
  assertApiOk,
  runWithCatamorphicError,
  useCatamorphic,
} from "@catamorphic/react";
import type { ProjectSummary } from "@catamorphic/react/types";
import { useQuery } from "@tanstack/react-query";

/** Profile filtering and runtime removal require a complete project catalog. */
export function useDesktopProjects() {
  const { apiClient } = useCatamorphic();
  return useQuery({
    queryKey: ["cat", "projects", "desktop-catalog"],
    queryFn: ({ signal }) =>
      runWithCatamorphicError(async () => {
        const items = new Map<string, ProjectSummary>();
        let offset = 0;
        let expectedTotal: number | undefined;
        while (true) {
          const page = assertApiOk(
            await apiClient.GET("/api/projects", {
              params: { query: { limit: 100, offset } },
              signal,
            }),
            "Projects response empty",
          );
          expectedTotal ??= page.total;
          if (page.total !== expectedTotal)
            throw new Error("Your projects changed while loading. Try again.");
          for (const project of page.items) {
            if (items.has(project.id))
              throw new Error(
                "Your projects changed while loading. Try again.",
              );
            items.set(project.id, project);
          }
          offset += page.items.length;
          if (offset === page.total)
            return { items: [...items.values()], total: items.size };
          // Never publish an incomplete catalog as an authoritative empty list.
          if (page.items.length === 0)
            throw new Error(
              "Could not finish loading your projects. Try again.",
            );
        }
      }),
  });
}
