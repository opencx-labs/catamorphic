import type {
  GrantMembershipInput,
  Identity,
  Membership,
  ProjectRoleEntry,
} from "@catamorphic/core";
import { z } from "zod";
import type { StockAuth, StockAuthUser } from "../auth/stock-auth.js";

export const ProvisionStockUserInputSchema = z.strictObject({
  username: z.string().trim().min(3).max(30),
  name: z.string().trim().min(1).max(200),
  password: z.string().min(8).max(128),
  email: z.email().optional(),
  memberships: z
    .array(
      z.strictObject({
        projectId: z.string().min(1),
        roles: z.array(z.string().min(1)).min(1),
        grants: z.record(z.string(), z.array(z.string())).optional(),
      }),
    )
    .optional(),
});

export type ProvisionStockUserInput = z.infer<
  typeof ProvisionStockUserInputSchema
>;

export interface StockProvisioningServices {
  roles: {
    list(identity: Identity, projectId: string): Promise<ProjectRoleEntry[]>;
  };
  memberships: {
    grant(input: GrantMembershipInput): Promise<Membership>;
  };
}

export async function provisionStockUser(args: {
  auth: Pick<StockAuth, "createLocalUser">;
  services: StockProvisioningServices;
  operatorIdentity: Identity;
  input: ProvisionStockUserInput;
}): Promise<{ user: StockAuthUser; memberships: Membership[] }> {
  const assignments = args.input.memberships ?? [];
  const projectRoles = await Promise.all(
    assignments.map(async (assignment) => ({
      assignment,
      entries: await args.services.roles.list(
        args.operatorIdentity,
        assignment.projectId,
      ),
    })),
  );

  for (const { assignment, entries } of projectRoles) {
    for (const role of assignment.roles) {
      const valid = entries.some(
        (entry) => entry.slug === role && entry.definition !== undefined,
      );
      if (!valid) {
        throw new Error(
          `Project ${assignment.projectId} has no valid committed role "${role}". Add roles/${role}.json before provisioning this membership.`,
        );
      }
    }
  }

  const user = await args.auth.createLocalUser({
    username: args.input.username,
    name: args.input.name,
    password: args.input.password,
    ...(args.input.email ? { email: args.input.email } : {}),
  });
  const memberships = await Promise.all(
    assignments.map((assignment) =>
      args.services.memberships.grant({
        identity: args.operatorIdentity,
        projectId: assignment.projectId,
        externalUserId: user.id,
        roles: assignment.roles,
        ...(assignment.grants ? { grants: assignment.grants } : {}),
      }),
    ),
  );

  return { user, memberships };
}
