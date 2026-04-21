"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { Template } from "../lib/api-types.js";
import { useCatamorphic } from "../provider.js";

export function useTemplates(): UseQueryResult<Template[], Error> {
  const { apiClient } = useCatamorphic();
  return useQuery<Template[]>({
    queryKey: ["cat", "templates"],
    queryFn: async () => {
      const { data, error } = await apiClient.GET("/api/templates");
      if (error) throw error;
      if (!data) throw new Error("Templates response empty");
      return data;
    },
  });
}
