"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { Template } from "../lib/api-types.js";
import {
  assertApiOk,
  type CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

export function useTemplates(): UseQueryResult<Template[], CatamorphicError> {
  const { apiClient } = useCatamorphic();
  return useQuery<Template[], CatamorphicError>({
    queryKey: ["cat", "templates"],
    queryFn: () =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.GET("/api/templates");
        return assertApiOk(result, "Templates response empty");
      }),
  });
}
