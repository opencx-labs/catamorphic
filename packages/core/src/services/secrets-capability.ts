import type { SecretStatusEntry } from "@catamorphic/workflow";
import { z } from "zod";
import { assertProjectPermission } from "./artifact-scope.js";
import type {
  CapabilityProviderRuntime,
  HostCallContext,
} from "./capability-providers.js";
import {
  SecretMemberNotFoundError,
  type SecretsService,
} from "./secrets-service.js";

/** The host calls on a project's secrets (ADR 0210). */
export const SECRETS_CAPABILITY = "catamorphic.secrets";

const NameSchema = z.string().min(1).max(255);
/** A member by id, or by the email they sign in with. */
const MemberSchema = z.string().trim().min(1).max(320);

const ListSchema = z.strictObject({});
const SetSchema = z.strictObject({
  name: NameSchema,
  value: z.string(),
  member: MemberSchema.optional(),
});
const DeleteSchema = z.strictObject({
  name: NameSchema,
  member: MemberSchema.optional(),
});

function parse<T>(schema: z.ZodType<T>, args: unknown, call: string): T {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success)
    throw new Error(
      `${SECRETS_CAPABILITY}.${call}: ${parsed.error.issues
        .map((issue) =>
          issue.path.length > 0
            ? `${issue.path.join(".")}: ${issue.message}`
            : issue.message,
        )
        .join("; ")}`,
    );
  return parsed.data;
}

/**
 * `host["catamorphic.secrets"]` (ADR 0210): a workflow lists the
 * project's secrets and sets or removes shared and members' values, as its
 * run's caller confined to what the workflow declared (ADR 0158):
 * `secrets:read` to list, `secrets:write` to change. No call returns a
 * value.
 */
export function secretsCapability(deps: {
  /** Read per call: the service is constructed after the registry. */
  secrets: () => SecretsService | undefined;
  /** How the host names a member by email; without it, ids only. */
  memberIdForEmail?: (args: {
    tenantId: string;
    email: string;
  }) => Promise<string | null>;
}): CapabilityProviderRuntime {
  const service = (): SecretsService => {
    const secrets = deps.secrets();
    if (!secrets) throw new Error("Secrets are not configured on this host");
    return secrets;
  };
  const memberId = async (
    context: HostCallContext,
    member: string | undefined,
  ): Promise<string | null> => {
    if (member === undefined) return null;
    if (!member.includes("@")) return member;
    if (!deps.memberIdForEmail)
      throw new Error(
        "This host names members by id: pass the member's id instead of an email",
      );
    const id = await deps.memberIdForEmail({
      tenantId: context.caller.tenantId,
      email: member.toLowerCase(),
    });
    if (!id) throw new SecretMemberNotFoundError(member);
    return id;
  };

  return {
    name: SECRETS_CAPABILITY,
    description:
      "List the project's secrets and set or remove shared and members' own values; never reads a value",
    calls: {
      list: async (context, args) => {
        parse(ListSchema, args, "list");
        assertProjectPermission(
          context.caller,
          context.projectId,
          "secrets:read",
        );
        const items = await service().list({
          identity: context.caller,
          projectId: context.projectId,
        });
        return {
          items: items.map(
            (entry): SecretStatusEntry => ({
              name: entry.name,
              ...(entry.label ? { label: entry.label } : {}),
              ...(entry.description ? { description: entry.description } : {}),
              source: entry.source,
              shared: entry.shared,
              members: entry.members.map((value) => value.member),
              environments: entry.environments,
            }),
          ),
        };
      },
      set: async (context, args) => {
        const input = parse(SetSchema, args, "set");
        assertProjectPermission(
          context.caller,
          context.projectId,
          "secrets:write",
        );
        const member = await memberId(context, input.member);
        if (member === null) {
          const status = await service().upsert({
            identity: context.caller,
            projectId: context.projectId,
            name: input.name,
            value: input.value,
          });
          return {
            name: input.name,
            member: null,
            updatedAt: status.updatedAt ?? new Date().toISOString(),
          };
        }
        return service().setMember({
          identity: context.caller,
          projectId: context.projectId,
          name: input.name,
          member,
          value: input.value,
        });
      },
      delete: async (context, args) => {
        const input = parse(DeleteSchema, args, "delete");
        assertProjectPermission(
          context.caller,
          context.projectId,
          "secrets:write",
        );
        const member = await memberId(context, input.member);
        const deleted =
          member === null
            ? await service().delete({
                identity: context.caller,
                projectId: context.projectId,
                name: input.name,
              })
            : await service().deleteMember({
                identity: context.caller,
                projectId: context.projectId,
                name: input.name,
                member,
              });
        return { name: input.name, member, deleted };
      },
    },
  };
}
