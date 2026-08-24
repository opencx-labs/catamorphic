"use client";

import {
  type UseMutationResult,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  assertApiOk,
  type CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

export type AuthorizationChallenge =
  | { kind: "url"; url: string; expiresAt?: string }
  | {
      kind: "device";
      verificationUrl: string;
      userCode: string;
      expiresAt?: string;
    }
  | {
      kind: "form";
      fields: Array<{
        name: string;
        label: string;
        secret: boolean;
        required: boolean;
      }>;
    };

export function useAuthorizeConnection(args: {
  projectId: string;
  environment: string;
  alias: string;
}): UseMutationResult<
  { authorizationId: string; challenge: AuthorizationChallenge },
  CatamorphicError,
  { redirectUri?: string }
> {
  const { apiClient, baseUrl } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) =>
      runWithCatamorphicError(async () => {
        const redirectUri =
          input?.redirectUri ??
          (baseUrl
            ? new URL(
                "/api/connection-authorizations/callback",
                baseUrl,
              ).toString()
            : undefined);
        if (!redirectUri) {
          throw new Error(
            "A redirect URI is required when CatamorphicProvider has no baseUrl",
          );
        }
        const result = await apiClient.POST(
          "/api/projects/{projectId}/environments/{environment}/connections/{alias}/authorize",
          {
            params: { path: args },
            body: { redirectUri },
          },
        );
        return assertApiOk(result, "Authorization could not be started");
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [
          "cat",
          "project",
          args.projectId,
          "environment",
          args.environment,
          "connections",
        ],
      }),
  });
}
