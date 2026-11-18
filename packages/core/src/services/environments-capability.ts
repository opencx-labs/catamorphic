import { z } from "zod";
import { hasProjectPermission, type Identity } from "../identity.js";
import { AccessDeniedError } from "./artifact-scope.js";
import {
  CacheFillRefusedError,
  type CacheFillsService,
} from "./cache-fills.js";
import type {
  CapabilityProviderRuntime,
  HostCallContext,
} from "./capability-providers.js";
import { requireAttemptTime } from "./run-abortable.js";

/** The host calls on a project's Environments (ADR 0334). */
export const ENVIRONMENTS_CAPABILITY = "catamorphic.environments";

const FillCacheSchema = z.strictObject({
  environment: z.string().min(1).max(200),
  cache: z.string().min(1).max(40),
  /** A revision Work published from main; the current one by default. */
  commit: z.string().min(1).max(64).optional(),
  idempotencyKey: z.string().min(1).max(200),
});

/**
 * `host["catamorphic.environments"]` (ADR 0334): a workflow that declared
 * `caches:write` asks Work to fill an Environment cache. It names the cache
 * and at most a published revision, never a command or a ref: the command
 * is the cache's own, read from the published program.
 */
export function environmentsCapability(deps: {
  /** Read per call: the service is constructed after the registry. */
  cacheFills: () => CacheFillsService | undefined;
  authorize(context: HostCallContext): Promise<Identity>;
}): CapabilityProviderRuntime {
  return {
    name: ENVIRONMENTS_CAPABILITY,
    description:
      "Fill the project's Environment caches from a revision published from main",
    calls: {
      fillCache: async (context, args) => {
        const parsed = FillCacheSchema.safeParse(args ?? {});
        if (!parsed.success)
          throw new CacheFillRefusedError(
            `${ENVIRONMENTS_CAPABILITY}.fillCache: ${parsed.error.issues
              .map((issue) =>
                issue.path.length > 0
                  ? `${issue.path.join(".")}: ${issue.message}`
                  : issue.message,
              )
              .join("; ")}`,
          );
        const identity = await deps.authorize(context);
        if (!hasProjectPermission(identity, context.projectId, "caches:write"))
          throw new AccessDeniedError(
            "Filling a cache needs caches:write: declare it in the workflow's permissions",
          );
        const service = deps.cacheFills();
        if (!service)
          throw new Error("Environment caches are not configured on this host");
        requireAttemptTime(context);
        return service.request({
          identity,
          projectId: context.projectId,
          environment: parsed.data.environment,
          cache: parsed.data.cache,
          ...(parsed.data.commit ? { commit: parsed.data.commit } : {}),
          idempotencyKey: parsed.data.idempotencyKey,
        });
      },
    },
  };
}
