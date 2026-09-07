"use client";
import { useQuery } from "@tanstack/react-query";
import { assertApiOk, runWithCatamorphicError } from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

export function useConnectionAuthorizationStatus(state: string | undefined) {
  const { apiClient } = useCatamorphic();
  return useQuery({
    queryKey: ["cat", "authorization", state],
    enabled: Boolean(state),
    queryFn: () =>
      runWithCatamorphicError(async () => {
        if (!state) throw new Error("Authorization is required");
        return assertApiOk(
          await apiClient.POST("/api/connection-authorizations/status", {
            body: { state },
          }),
          "Sign-in status could not be checked",
        );
      }),
    refetchInterval: (query) =>
      ["completed", "canceled", "expired"].includes(
        query.state.data?.status ?? "",
      )
        ? false
        : 1500,
  });
}
