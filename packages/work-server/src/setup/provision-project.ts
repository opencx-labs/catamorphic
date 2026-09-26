import {
  type Identity,
  type Project,
  type ProjectRoleEntry,
  type ProposalResult,
  type ProposeInput,
  type RoleDefinition,
  RoleDefinitionSchema,
} from "@catamorphic/core";
import { PROJECT_ROLES_DIR } from "@catamorphic/workflow/project-layout";
import { z } from "zod";
import type { AdmissionMode } from "../admission/admission-service.js";

const RoleSlugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const ProvisionWorkProjectInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    githubRepository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .optional(),
    /**
     * Required for a project the server creates. For an imported repository,
     * roles its default branch already defines win and these are unused;
     * otherwise these are proposed to it as a pull request (ADR 0170).
     */
    roles: z
      .array(
        z.strictObject({
          slug: RoleSlugSchema,
          definition: RoleDefinitionSchema,
        }),
      )
      .min(1)
      .optional(),
    admission: z.strictObject({
      mode: z.enum(["invitation_only", "approved_domain", "request", "open"]),
      defaultRole: RoleSlugSchema,
      approvedDomains: z.array(z.string().trim().min(1)).default([]),
      /** Directory groups whose members hold these roles (ADR 0161). */
      directoryRoles: z
        .array(
          z.strictObject({
            group: z.string().trim().toLowerCase().min(3),
            roles: z.array(RoleSlugSchema).min(1),
          }),
        )
        .default([]),
    }),
  })
  .superRefine((input, context) => {
    if (!input.roles) {
      // An imported repository may define its own roles; they are checked
      // against the admission policy once the repository is read.
      if (!input.githubRepository) {
        context.addIssue({
          code: "custom",
          path: ["roles"],
          message: "Roles are required for a project the server creates",
        });
      }
      return;
    }
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
    for (const mapping of input.admission.directoryRoles) {
      for (const role of mapping.roles) {
        if (!seen.has(role)) {
          context.addIssue({
            code: "custom",
            path: ["admission", "directoryRoles"],
            message: `Directory role "${role}" must be supplied`,
          });
        }
      }
    }
    if (!seen.has(input.admission.defaultRole)) {
      context.addIssue({
        code: "custom",
        path: ["admission", "defaultRole"],
        message: `Admission default role "${input.admission.defaultRole}" must be supplied`,
      });
    }
  });

export type ProvisionWorkProjectInput = z.input<
  typeof ProvisionWorkProjectInputSchema
>;

/**
 * Where the project's roles came from. `committed`: the server created the
 * project and committed the roles to its own origin. `repository`: the
 * imported repository's default branch already defines roles, used as they
 * are. `proposed`: the repository has none, so the roles were opened as a
 * pull request on a `work/` branch (ADR 0170); they take effect when it merges.
 */
export type ProvisionedRoles =
  | { source: "committed"; slugs: string[] }
  | { source: "repository"; slugs: string[] }
  | {
      source: "proposed";
      slugs: string[];
      branch: string;
      pullRequest?: { url: string; number: number };
    };

interface WorkProjectProvisioningServices {
  github?: {
    importRepo(
      identity: Identity,
      input: { name: string; fullName: string },
    ): Promise<Project>;
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
    list(identity: Identity, projectId: string): Promise<ProjectRoleEntry[]>;
    invalidate(projectId: string): void;
  };
  proposals: {
    propose(input: ProposeInput): Promise<ProposalResult>;
  };
  admission: {
    setPolicy(input: {
      identity: Identity;
      projectId: string;
      mode: AdmissionMode;
      defaultRole: string;
      approvedDomains: readonly string[];
      directoryRoles?: readonly { group: string; roles: readonly string[] }[];
      pendingRoles?: Readonly<Record<string, RoleDefinition>>;
    }): Promise<void>;
  };
}

/**
 * Create or import a company project, give it roles, and set its admission
 * policy. An imported repository is attached (ADR 0170): the server never
 * commits or pushes to its default branch. Roles it already defines are used
 * as they are; otherwise they are proposed as a pull request, and the
 * server's published sync picks them up once it merges.
 */
export async function provisionWorkProject(args: {
  services: WorkProjectProvisioningServices;
  operatorIdentity: Identity;
  githubIdentity?: Identity;
  input: ProvisionWorkProjectInput;
}): Promise<{ project: Project; roles: ProvisionedRoles }> {
  const parsed = ProvisionWorkProjectInputSchema.parse(args.input);
  const { services, operatorIdentity } = args;
  const policy = (
    projectId: string,
    pendingRoles?: Record<string, RoleDefinition>,
  ) =>
    services.admission.setPolicy({
      identity: operatorIdentity,
      projectId,
      mode: parsed.admission.mode,
      defaultRole: parsed.admission.defaultRole,
      approvedDomains: parsed.admission.approvedDomains,
      directoryRoles: parsed.admission.directoryRoles,
      ...(pendingRoles ? { pendingRoles } : {}),
    });
  const supplied = [...(parsed.roles ?? [])].sort((left, right) =>
    left.slug.localeCompare(right.slug),
  );
  const roleFiles = supplied.map((role) => ({
    path: `${PROJECT_ROLES_DIR}/${role.slug}.json`,
    content: `${JSON.stringify(role.definition, null, 2)}\n`,
  }));
  const files = Object.fromEntries(
    roleFiles.map((file) => [file.path, file.content]),
  );
  const slugs = supplied.map((role) => role.slug);

  if (!parsed.githubRepository) {
    // The server's own project: its origin is Work's, so roles commit directly.
    const project = await services.projects.create(operatorIdentity, {
      name: parsed.name,
    });
    await services.deployment.deploy(
      operatorIdentity.tenantId,
      project.id,
      operatorIdentity.externalUserId,
      { message: "Configure project roles", files },
    );
    services.roles.invalidate(project.id);
    await policy(project.id);
    return { project, roles: { source: "committed", slugs } };
  }
  if (!services.github || !args.githubIdentity) {
    throw new Error(
      "Configure the server's GitHub connection before importing a company repository",
    );
  }
  const project = await services.github.importRepo(args.githubIdentity, {
    name: parsed.name,
    fullName: parsed.githubRepository,
  });
  const existing = (
    await services.roles.list(operatorIdentity, project.id)
  ).filter((entry) => entry.definition);
  if (existing.length > 0) {
    await policy(project.id);
    return {
      project,
      roles: {
        source: "repository",
        slugs: existing.map((entry) => entry.slug),
      },
    };
  }
  if (supplied.length === 0) {
    throw new Error(
      `${parsed.githubRepository} defines no roles in ${PROJECT_ROLES_DIR}. Supply roles to propose them.`,
    );
  }
  const proposal = await services.proposals.propose({
    identity: operatorIdentity,
    projectId: project.id,
    title: "Configure Work roles",
    body: [
      "Work reads who may do what in this project from the role files under",
      `\`${PROJECT_ROLES_DIR}/\`. Members can join with these roles once this`,
      "pull request is merged into the default branch.",
    ].join("\n"),
    changes: roleFiles,
  });
  await policy(
    project.id,
    Object.fromEntries(supplied.map((role) => [role.slug, role.definition])),
  );
  return {
    project,
    roles: {
      source: "proposed",
      slugs,
      branch: proposal.branch,
      ...(proposal.pullRequest ? { pullRequest: proposal.pullRequest } : {}),
    },
  };
}
