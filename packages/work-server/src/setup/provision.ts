import type {
  GrantMembershipInput,
  Identity,
  Membership,
  ProjectRoleEntry,
} from "@catamorphic/core";
import { z } from "zod";
import type { WorkAuth, WorkAuthUser } from "../auth/work-auth.js";

export const ProvisionWorkUserInputSchema = z.strictObject({
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

export type ProvisionWorkUserInput = z.infer<
  typeof ProvisionWorkUserInputSchema
>;

export interface WorkProvisioningServices {
  roles: {
    list(identity: Identity, projectId: string): Promise<ProjectRoleEntry[]>;
  };
  memberships: {
    grant(input: GrantMembershipInput): Promise<Membership>;
  };
}

export async function provisionWorkUser(args: {
  auth: Pick<WorkAuth, "createLocalUser">;
  services: WorkProvisioningServices;
  operatorIdentity: Identity;
  input: ProvisionWorkUserInput;
}): Promise<{ user: WorkAuthUser; memberships: Membership[] }> {
  const assignments = args.input.memberships ?? [];
  await assertCommittedRoles({
    services: args.services,
    operatorIdentity: args.operatorIdentity,
    assignments,
  });

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

export const GrantWorkMembershipInputSchema = z.strictObject({
  /** The verified email of a user who has signed in at least once. */
  email: z.email(),
  projectId: z.string().min(1),
  roles: z.array(z.string().min(1)).min(1),
  grants: z.record(z.string(), z.array(z.string())).optional(),
});

export type GrantWorkMembershipInput = z.infer<
  typeof GrantWorkMembershipInputSchema
>;

/**
 * Bind an existing user, found by verified email, to project roles. This is
 * how a setup agent makes the first manager of a deployment that signs in
 * only through a company provider and has no directory role mapping.
 */
export async function grantWorkMembership(args: {
  auth: Pick<WorkAuth, "findUserByEmail">;
  services: WorkProvisioningServices;
  operatorIdentity: Identity;
  input: GrantWorkMembershipInput;
}): Promise<{ user: WorkAuthUser; membership: Membership }> {
  await assertCommittedRoles({
    services: args.services,
    operatorIdentity: args.operatorIdentity,
    assignments: [args.input],
  });
  const user = await args.auth.findUserByEmail({ email: args.input.email });
  if (!user?.emailVerified) {
    throw new Error(
      "No user with that verified email has signed in yet. Ask them to sign in once, then retry.",
    );
  }
  const membership = await args.services.memberships.grant({
    identity: args.operatorIdentity,
    projectId: args.input.projectId,
    externalUserId: user.id,
    roles: args.input.roles,
    ...(args.input.grants ? { grants: args.input.grants } : {}),
  });
  return { user, membership };
}

async function assertCommittedRoles(args: {
  services: WorkProvisioningServices;
  operatorIdentity: Identity;
  assignments: ReadonlyArray<{ projectId: string; roles: readonly string[] }>;
}): Promise<void> {
  for (const assignment of args.assignments) {
    const entries = await args.services.roles.list(
      args.operatorIdentity,
      assignment.projectId,
    );
    for (const role of assignment.roles) {
      const valid = entries.some(
        (entry) => entry.slug === role && entry.definition !== undefined,
      );
      if (!valid) {
        throw new Error(
          `Project ${assignment.projectId} has no valid committed role "${role}". Add .catamorphic/roles/${role}.json before provisioning this membership.`,
        );
      }
    }
  }
}
