import {
  type Identity,
  type Project,
  RoleDefinitionSchema,
} from "@catamorphic/core";
import { z } from "zod";
import type { AdmissionMode } from "../admission/admission-service.js";

const RoleSlugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const ProvisionStockProjectInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    githubRepository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .optional(),
    roles: z
      .array(
        z.strictObject({
          slug: RoleSlugSchema,
          definition: RoleDefinitionSchema,
        }),
      )
      .min(1),
    admission: z.strictObject({
      mode: z.enum(["invitation_only", "approved_domain", "request", "open"]),
      defaultRole: RoleSlugSchema,
      approvedDomains: z.array(z.string().trim().min(1)).default([]),
    }),
  })
  .superRefine((input, context) => {
    const seen = new Set<string>();
    for (const role of input.roles) {
      if (seen.has(role.slug)) {
        context.addIssue({
          code: "custom",
          path: ["roles"],
          message: `Role "${role.slug}" is duplicated`,
        });
      }
      seen.add(role.slug);
    }
    if (!seen.has(input.admission.defaultRole)) {
      context.addIssue({
        code: "custom",
        path: ["admission", "defaultRole"],
        message: `Admission default role "${input.admission.defaultRole}" must be supplied`,
      });
    }
  });

export type ProvisionStockProjectInput = z.infer<
  typeof ProvisionStockProjectInputSchema
>;

interface StockProjectProvisioningServices {
  github?: {
    importRepo(
      identity: Identity,
      input: { name: string; fullName: string },
    ): Promise<Project>;
    pushProject(identity: Identity, projectId: string): Promise<void>;
  };
  projects: {
    create(identity: Identity, input: { name: string }): Promise<Project>;
  };
  deployment: {
    deploy(
      tenantId: string,
      projectId: string,
      externalUserId: string,
      input: { message: string; files: Record<string, string> },
    ): Promise<unknown>;
  };
  roles: {
    invalidate(projectId: string): void;
  };
  admission: {
    setPolicy(input: {
      identity: Identity;
      projectId: string;
      mode: AdmissionMode;
      defaultRole: string;
      approvedDomains: readonly string[];
    }): Promise<void>;
  };
}

export async function provisionStockProject(args: {
  services: StockProjectProvisioningServices;
  operatorIdentity: Identity;
  githubIdentity?: Identity;
  input: ProvisionStockProjectInput;
}): Promise<{ project: Project }> {
  const parsed = ProvisionStockProjectInputSchema.parse(args.input);
  if (
    parsed.githubRepository &&
    (!args.services.github || !args.githubIdentity)
  ) {
    throw new Error(
      "Configure the server's GitHub connection before importing a company repository",
    );
  }
  const project =
    parsed.githubRepository && args.services.github && args.githubIdentity
      ? await args.services.github.importRepo(args.githubIdentity, {
          name: parsed.name,
          fullName: parsed.githubRepository,
        })
      : await args.services.projects.create(args.operatorIdentity, {
          name: parsed.name,
        });
  const files = Object.fromEntries(
    [...parsed.roles]
      .sort((left, right) => left.slug.localeCompare(right.slug))
      .map((role) => [
        `.catamorphic/roles/${role.slug}.json`,
        `${JSON.stringify(role.definition, null, 2)}\n`,
      ]),
  );
  await args.services.deployment.deploy(
    args.operatorIdentity.tenantId,
    project.id,
    args.operatorIdentity.externalUserId,
    { message: "Configure project roles", files },
  );
  args.services.roles.invalidate(project.id);
  if (parsed.githubRepository && args.services.github && args.githubIdentity) {
    await args.services.github.pushProject(args.githubIdentity, project.id);
  }
  await args.services.admission.setPolicy({
    identity: args.operatorIdentity,
    projectId: project.id,
    mode: parsed.admission.mode,
    defaultRole: parsed.admission.defaultRole,
    approvedDomains: parsed.admission.approvedDomains,
  });
  return { project };
}
