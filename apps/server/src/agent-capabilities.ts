import {
  type AgentCapabilityOptions,
  type CatamorphicCore,
  defineAgentCapability,
  hasProjectPermission,
} from "@catamorphic/core";
import { z } from "zod";
import type { StockAuth } from "./auth/stock-auth.js";

/** Stock-host profile and directory; no framework-owned identity model. */
export function stockAgentCapabilities(args: {
  core(): CatamorphicCore;
  auth(): StockAuth;
  custom?: AgentCapabilityOptions;
}): AgentCapabilityOptions {
  const directory = defineAgentCapability({
    revision: "1",
    name: "people.search",
    description:
      "Find project members by user ID and read their display names. Uses ordinary membership-management permission. No email addresses or tenant-wide directory are returned.",
    effect: "read",
    inputSchema: z
      .object({
        query: z.string().max(200).default(""),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(20).default(10),
      })
      .strict(),
    outputSchema: z.object({
      items: z.array(
        z.object({ id: z.string(), displayName: z.string().optional() }),
      ),
      nextCursor: z.string().optional(),
    }),
    authorize: ({ identity, projectId }) =>
      hasProjectPermission(identity, projectId, "memberships:manage"),
    execute: async ({ identity, projectId }, input) => {
      const members = await args
        .core()
        .memberships.list({ identity, projectId });
      const found = members
        .map((member) => member.externalUserId)
        .sort()
        .filter(
          (id) =>
            id.includes(input.query) && (!input.cursor || id > input.cursor),
        );
      const items = await Promise.all(
        found.slice(0, input.limit).map(async (id) => {
          const user = await args.auth().findUserById({ userId: id });
          return { id, ...(user ? { displayName: user.name } : {}) };
        }),
      );
      return {
        items,
        ...(found.length > input.limit
          ? { nextCursor: found[input.limit - 1] }
          : {}),
      };
    },
  });
  return {
    ...args.custom,
    currentUser:
      args.custom?.currentUser ??
      (async ({ identity }) => {
        const user = await args
          .auth()
          .findUserById({ userId: identity.externalUserId });
        return user ? { displayName: user.name } : {};
      }),
    capabilities: [
      ...(args.custom?.capabilities?.some(
        (item) => item.name === directory.name,
      )
        ? []
        : [directory]),
      ...(args.custom?.capabilities ?? []),
    ],
  };
}
