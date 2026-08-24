import { getTracer, withSpan } from "@catamorphic/otel";
import type { Identity } from "../identity.js";
import type {
  ConnectionRequirement,
  ResolvedConnectionBinding,
} from "./connection-types.js";
import { normalizeConnectionRequirement } from "./connection-types.js";
import {
  AuthenticationRequiredError,
  type ConnectionsService,
  ConnectionUnavailableError,
} from "./connections-service.js";

const tracer = getTracer("@catamorphic/core");

export class ConnectionAdmissionService {
  constructor(private readonly connections: ConnectionsService) {}

  async admit(args: {
    identity: Identity;
    projectId: string;
    environment: string;
    requirements?: readonly (string | ConnectionRequirement)[];
    unattended?: boolean;
  }): Promise<ResolvedConnectionBinding[]> {
    return withSpan(
      {
        tracer,
        name: "connection.admit",
        attributes: {
          "catamorphic.tenant.id": args.identity.tenantId,
          "catamorphic.project.id": args.projectId,
          "catamorphic.connection.environment": args.environment,
          "catamorphic.connection.requirement_count":
            args.requirements?.length ?? 0,
          "catamorphic.connection.unattended": args.unattended ?? false,
        },
      },
      () => this.admitUninstrumented(args),
    );
  }

  async admitSnapshot(args: {
    identity: Identity;
    projectId: string;
    environment: string;
    snapshot: readonly ResolvedConnectionBinding[];
  }): Promise<ResolvedConnectionBinding[]> {
    return this.connections.resolveSnapshot(args);
  }

  private async admitUninstrumented(args: {
    identity: Identity;
    projectId: string;
    environment: string;
    requirements?: readonly (string | ConnectionRequirement)[];
    unattended?: boolean;
  }): Promise<ResolvedConnectionBinding[]> {
    const active = (args.requirements ?? []).map(
      normalizeConnectionRequirement,
    );
    if (active.length === 0) return [];
    const resolved: ResolvedConnectionBinding[] = [];
    for (const requirement of active) {
      try {
        resolved.push(
          ...(await this.connections.resolve({
            identity: args.identity,
            projectId: args.projectId,
            environment: args.environment,
            aliases: [requirement.alias],
            principalsByAlias: requirement.principal
              ? { [requirement.alias]: requirement.principal }
              : undefined,
            unattended: args.unattended,
          })),
        );
      } catch (error) {
        if (
          requirement.optional &&
          (error instanceof AuthenticationRequiredError ||
            error instanceof ConnectionUnavailableError)
        ) {
          continue;
        }
        throw error;
      }
    }
    return resolved.map((binding) => {
      const requirement = active.find(
        (candidate) => candidate.alias === binding.alias,
      );
      if (
        requirement?.principal &&
        requirement.principal !== "either" &&
        (requirement.principal === "member"
          ? binding.principalKind !== "member"
          : binding.principalKind === "member")
      ) {
        throw new Error(
          `Connection '${binding.alias}' requires principal '${requirement.principal}'`,
        );
      }
      const requested = requirement?.capabilities;
      return requested
        ? {
            ...binding,
            capabilities: binding.capabilities.filter((capability) =>
              requested.includes(capability),
            ),
          }
        : binding;
    });
  }
}
