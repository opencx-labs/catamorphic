import type { Identity } from "@catamorphic/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { StockAuth } from "../auth/stock-auth.js";
import type {
  AdmissionMode,
  AdmissionUser,
  StockAdmissionService,
} from "./admission-service.js";

const PolicyInputSchema = z.strictObject({
  mode: z.enum(["invitation_only", "approved_domain", "request", "open"]),
  defaultRole: z.string().trim().min(1),
  approvedDomains: z.array(z.string().trim().min(1)).default([]),
});

const InvitationInputSchema = z.strictObject({
  email: z.email().optional(),
  roles: z.array(z.string().trim().min(1)).min(1).optional(),
  grants: z.record(z.string(), z.array(z.string())).optional(),
  expiresAt: z.iso.datetime().optional(),
});

const DecisionInputSchema = z.strictObject({
  decision: z.enum(["approved", "denied"]),
});

interface AdmissionRoutesOptions {
  publicBases: readonly string[];
  auth: Pick<StockAuth, "findUserById" | "resolveAccessToken">;
  identityForUser(input: { externalUserId: string }): Promise<Identity>;
  admission: Pick<
    StockAdmissionService,
    | "setPolicy"
    | "listJoinableProjects"
    | "listAccessRequests"
    | "listMembers"
    | "createInvitation"
    | "redeemInvitation"
    | "join"
    | "requestAccess"
    | "decideRequest"
  >;
}

export function registerStockAdmissionRoutes(
  app: FastifyInstance,
  options: AdmissionRoutesOptions,
): void {
  app.get("/api/admission/projects", async (request, reply) => {
    const caller = await resolveCaller(request, options);
    if (!caller) return reply.status(401).send({ error: "Unauthorized" });
    return options.admission.listJoinableProjects(caller.user);
  });

  app.get(
    "/api/projects/:projectId/admission/members",
    async (request, reply) => {
      const caller = await resolveCaller(request, options);
      if (!caller) return reply.status(401).send({ error: "Unauthorized" });
      const { projectId } = request.params as { projectId: string };
      return admissionReply(reply, async () => {
        const memberships = await options.admission.listMembers({
          identity: caller.identity,
          projectId,
        });
        return Promise.all(
          memberships.map(async (membership) => {
            const user = await options.auth.findUserById({
              userId: membership.externalUserId,
            });
            return {
              ...membership,
              name: user?.name ?? null,
              email: user?.email ?? null,
            };
          }),
        );
      });
    },
  );

  app.put(
    "/api/projects/:projectId/admission/policy",
    async (request, reply) => {
      const caller = await resolveCaller(request, options);
      if (!caller) return reply.status(401).send({ error: "Unauthorized" });
      const parsed = PolicyInputSchema.safeParse(request.body);
      if (!parsed.success) return invalidInput(reply, parsed.error.issues);
      const { projectId } = request.params as { projectId: string };
      return admissionReply(reply, async () => {
        await options.admission.setPolicy({
          identity: caller.identity,
          projectId,
          mode: parsed.data.mode as AdmissionMode,
          defaultRole: parsed.data.defaultRole,
          approvedDomains: parsed.data.approvedDomains,
        });
        return { ok: true };
      });
    },
  );

  app.post(
    "/api/projects/:projectId/admission/invitations",
    async (request, reply) => {
      const caller = await resolveCaller(request, options);
      if (!caller) return reply.status(401).send({ error: "Unauthorized" });
      const parsed = InvitationInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalidInput(reply, parsed.error.issues);
      const { projectId } = request.params as { projectId: string };
      return admissionReply(reply, async () => {
        const invitation = await options.admission.createInvitation({
          identity: caller.identity,
          projectId,
          ...(parsed.data.email ? { email: parsed.data.email } : {}),
          ...(parsed.data.roles ? { roles: parsed.data.roles } : {}),
          ...(parsed.data.grants ? { grants: parsed.data.grants } : {}),
          ...(parsed.data.expiresAt
            ? { expiresAt: new Date(parsed.data.expiresAt) }
            : {}),
        });
        const links = options.publicBases.map((base) =>
          invitationLinks(base, projectId, invitation.id),
        );
        reply.status(201);
        return {
          ...invitation,
          connectLinks: links.map((link) => link.connect),
          webLinks: links.map((link) => link.web),
        };
      });
    },
  );

  app.post(
    "/api/projects/:projectId/admission/invitations/:invitationId/redeem",
    async (request, reply) => {
      const caller = await resolveCaller(request, options);
      if (!caller) return reply.status(401).send({ error: "Unauthorized" });
      const { projectId, invitationId } = request.params as {
        projectId: string;
        invitationId: string;
      };
      return admissionReply(reply, () =>
        options.admission.redeemInvitation({
          projectId,
          invitationId,
          user: caller.user,
        }),
      );
    },
  );

  app.post(
    "/api/projects/:projectId/admission/join",
    async (request, reply) => {
      const caller = await resolveCaller(request, options);
      if (!caller) return reply.status(401).send({ error: "Unauthorized" });
      const { projectId } = request.params as { projectId: string };
      return admissionReply(reply, () =>
        options.admission.join({ projectId, user: caller.user }),
      );
    },
  );

  app.post(
    "/api/projects/:projectId/admission/requests",
    async (request, reply) => {
      const caller = await resolveCaller(request, options);
      if (!caller) return reply.status(401).send({ error: "Unauthorized" });
      const { projectId } = request.params as { projectId: string };
      return admissionReply(reply, () =>
        options.admission.requestAccess({ projectId, user: caller.user }),
      );
    },
  );

  app.get(
    "/api/projects/:projectId/admission/requests",
    async (request, reply) => {
      const caller = await resolveCaller(request, options);
      if (!caller) return reply.status(401).send({ error: "Unauthorized" });
      const { projectId } = request.params as { projectId: string };
      return admissionReply(reply, () =>
        options.admission.listAccessRequests({
          identity: caller.identity,
          projectId,
        }),
      );
    },
  );

  app.post(
    "/api/projects/:projectId/admission/requests/:requestId/decision",
    async (request, reply) => {
      const caller = await resolveCaller(request, options);
      if (!caller) return reply.status(401).send({ error: "Unauthorized" });
      const parsed = DecisionInputSchema.safeParse(request.body);
      if (!parsed.success) return invalidInput(reply, parsed.error.issues);
      const { requestId } = request.params as { requestId: string };
      return admissionReply(reply, () =>
        options.admission.decideRequest({
          identity: caller.identity,
          requestId,
          decision: parsed.data.decision,
        }),
      );
    },
  );
}

async function resolveCaller(
  request: FastifyRequest,
  options: AdmissionRoutesOptions,
): Promise<{ identity: Identity; user: AdmissionUser } | null> {
  const raw = request.headers.authorization;
  const authorization = Array.isArray(raw) ? raw[0] : raw;
  if (!authorization) return null;
  const authenticated = await options.auth.resolveAccessToken({
    authorization,
  });
  if (!authenticated) return null;
  return {
    identity: await options.identityForUser({
      externalUserId: authenticated.userId,
    }),
    user: {
      id: authenticated.userId,
      email: authenticated.email,
      emailVerified: authenticated.emailVerified,
    },
  };
}

function invitationLinks(
  publicBase: string,
  projectId: string,
  invitationId: string,
): { connect: string; web: string } {
  const base = publicBase.replace(/\/+$/, "");
  const params = new URLSearchParams({
    server: `${base}/api`,
    project: projectId,
    invitation: invitationId,
  });
  return {
    connect: `catamorphic://connect?${params.toString()}`,
    web: `${base}/?${params.toString()}`,
  };
}

async function admissionReply(
  reply: FastifyReply,
  operation: () => Promise<unknown>,
) {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Admission failed";
    const status = /permission/i.test(message)
      ? 403
      : /requires an invitation|not approved|verified email/i.test(message)
        ? 403
        : /request access/i.test(message)
          ? 409
          : /no longer|expired/i.test(message)
            ? 404
            : 400;
    return reply.status(status).send({ error: message });
  }
}

function invalidInput(reply: FastifyReply, issues: unknown) {
  return reply.status(400).send({ error: "Invalid input", issues });
}
