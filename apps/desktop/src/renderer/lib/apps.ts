import type { AppIconName } from "@catamorphic/app";
import type { useCatamorphic } from "@catamorphic/react";

export interface AppSummary {
  name: string;
  title: string;
  id: string | null;
  activeVersionId: string | null;
  publishedAt: string | null;
  icon: AppIconName;
  /** Host data the newest ready build declares it reads (ADR 0148). */
  access: { sessions?: "read" };
}

/** One apps query for the sidebar, the palette and widgets (one cache). */
export function appsQuery({
  apiClient,
  projectId,
}: {
  apiClient: ReturnType<typeof useCatamorphic>["apiClient"];
  projectId: string | undefined;
}) {
  return {
    queryKey: ["cat", "project", projectId, "apps"],
    queryFn: async (): Promise<AppSummary[]> => {
      const result = await apiClient.GET("/api/projects/{projectId}/apps", {
        params: { path: { projectId: projectId ?? "" } },
      });
      // Source listing is builder-only; scoped members open granted app surfaces.
      if (result.response.status === 403) return [];
      if (!result.data) throw new Error("Failed to list apps");
      return result.data;
    },
  };
}
