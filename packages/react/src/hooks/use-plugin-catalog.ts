"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import {
  assertApiOk,
  type CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";
import type { PluginInfo } from "../types.js";

/**
 * Catalog of plugins discoverable across this Catamorphic instance.
 */
export function usePluginCatalog(): UseQueryResult<
  PluginInfo[],
  CatamorphicError
> {
  const { apiClient } = useCatamorphic();
  return useQuery<PluginInfo[], CatamorphicError>({
    queryKey: ["cat", "plugins", "catalog"],
    queryFn: () =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.GET("/api/plugins/catalog");
        return assertApiOk(result, "Plugin catalog response empty");
      }),
  });
}
