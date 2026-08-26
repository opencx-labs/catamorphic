import type { Membership } from "@catamorphic/core";
import type { DB } from "@catamorphic/db";
import { DEFAULT_SCHEMA, migrateToLatest } from "@catamorphic/db";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER_TENANT_ID } from "../server.js";
import { StockAdmissionService } from "./admission-service.js";

const operatorIdentity = {
  tenantId: SERVER_TENANT_ID,
  externalUserId: "operator",
};
const PROJECT_ID = "00000000-0000-4000-8000-000000000a01";

let pglite: PGlite;
let db: Kysely<DB>;

beforeEach(async () => {
  pglite = new PGlite({ extensions: { pgcrypto } });
  db = new Kysely<DB>({
    dialect: new PGliteDialect({ pglite }),
    plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
  });
  await migrateToLatest({ db, schema: DEFAULT_SCHEMA });
  await db
    .insertInto("tenants")
    .values({ id: SERVER_TENANT_ID, name: "Stock" })
    .execute();
  await db
    .insertInto("projects")
    .values({ id: PROJECT_ID, tenant_id: SERVER_TENANT_ID, name: "Brain" })
    .execute();
});

afterEach(async () => {
  await db.destroy();
});

function service() {
  const get = vi.fn(
    async (_input: unknown): Promise<Membership | null> => null,
  );
  const grant = vi.fn(async (input) => ({
    projectId: input.projectId,
    externalUserId: input.externalUserId,
    roles: [...input.roles],
    grants: input.grants ?? {},
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  }));
  const list = vi.fn(async (): Promise<Membership[]> => []);
  const admission = new StockAdmissionService({
    db,
    membershipWriterIdentity: operatorIdentity,
    roles: {
      list: async () => [
        {
          slug: "member",
          definition: {
            version: 1 as const,
            name: "Member",
            agents: ["assistant"],
          },
        },
      ],
    },
    memberships: { get, grant, list },
  });
  return { admission, get, grant, list };
}

describe("StockAdmissionService", () => {
  it("lists members for an ordinary membership manager", async () => {
    const { admission, list } = service();
    await admission.listMembers({
      identity: operatorIdentity,
      projectId: PROJECT_ID,
    });
    expect(list).toHaveBeenCalledWith({
      identity: operatorIdentity,
      projectId: PROJECT_ID,
    });
  });

  it("redeems a targeted invitation only for the verified invited email", async () => {
    const { admission, grant } = service();
    await admission.setPolicy({
      identity: operatorIdentity,
      projectId: PROJECT_ID,
      mode: "invitation_only",
      defaultRole: "member",
      approvedDomains: [],
    });
    const invitation = await admission.createInvitation({
      identity: operatorIdentity,
      projectId: PROJECT_ID,
      email: "ada@acme.dev",
    });

    await expect(
      admission.redeemInvitation({
        projectId: PROJECT_ID,
        invitationId: invitation.id,
        user: {
          id: "wrong-user",
          email: "grace@acme.dev",
          emailVerified: true,
        },
      }),
    ).rejects.toThrow("does not match");
    const membership = await admission.redeemInvitation({
      projectId: PROJECT_ID,
      invitationId: invitation.id,
      user: {
        id: "ada-user",
        email: "ADA@acme.dev",
        emailVerified: true,
      },
    });

    expect(membership.externalUserId).toBe("ada-user");
    expect(grant).toHaveBeenCalledWith({
      identity: operatorIdentity,
      projectId: PROJECT_ID,
      externalUserId: "ada-user",
      roles: ["member"],
      grants: {},
    });
  });

  it("admits a verified approved-domain user and rejects an unverified one", async () => {
    const { admission } = service();
    await admission.setPolicy({
      identity: operatorIdentity,
      projectId: PROJECT_ID,
      mode: "approved_domain",
      defaultRole: "member",
      approvedDomains: ["acme.dev"],
    });

    await expect(
      admission.join({
        projectId: PROJECT_ID,
        user: {
          id: "unverified-user",
          email: "person@acme.dev",
          emailVerified: false,
        },
      }),
    ).rejects.toThrow("verified email");
    const membership = await admission.join({
      projectId: PROJECT_ID,
      user: {
        id: "verified-user",
        email: "person@acme.dev",
        emailVerified: true,
      },
    });

    expect(membership.externalUserId).toBe("verified-user");
  });

  it("discovers only projects the signed-in user may join immediately", async () => {
    const { admission } = service();
    await admission.setPolicy({
      identity: operatorIdentity,
      projectId: PROJECT_ID,
      mode: "approved_domain",
      defaultRole: "member",
      approvedDomains: ["acme.dev"],
    });

    await expect(
      admission.listJoinableProjects({
        id: "ada",
        email: "ada@other.dev",
        emailVerified: true,
      }),
    ).resolves.toEqual([]);
    await expect(
      admission.listJoinableProjects({
        id: "ada",
        email: "ada@acme.dev",
        emailVerified: true,
      }),
    ).resolves.toEqual([{ id: PROJECT_ID, name: "Brain" }]);
  });

  it("never replaces the roles of an existing member during reconnect", async () => {
    const { admission, get, grant } = service();
    get.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      externalUserId: "manager-user",
      roles: ["manager"],
      grants: {},
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
    });
    await admission.setPolicy({
      identity: operatorIdentity,
      projectId: PROJECT_ID,
      mode: "open",
      defaultRole: "member",
      approvedDomains: [],
    });

    const membership = await admission.join({
      projectId: PROJECT_ID,
      user: {
        id: "manager-user",
        email: "manager@example.com",
        emailVerified: true,
      },
    });

    expect(membership.roles).toEqual(["manager"]);
    expect(grant).not.toHaveBeenCalled();
  });

  it("records a request without granting access until a manager approves it", async () => {
    const { admission, grant } = service();
    await admission.setPolicy({
      identity: operatorIdentity,
      projectId: PROJECT_ID,
      mode: "request",
      defaultRole: "member",
      approvedDomains: [],
    });

    const request = await admission.requestAccess({
      projectId: PROJECT_ID,
      user: {
        id: "requester",
        email: "person@example.com",
        emailVerified: true,
      },
    });
    expect(grant).not.toHaveBeenCalled();
    await expect(
      admission.listAccessRequests({
        identity: operatorIdentity,
        projectId: PROJECT_ID,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: request.id,
        email: "person@example.com",
        status: "pending",
      }),
    ]);

    const decided = await admission.decideRequest({
      identity: operatorIdentity,
      requestId: request.id,
      decision: "approved",
    });

    expect(decided.status).toBe("approved");
    expect(grant).toHaveBeenCalledWith(
      expect.objectContaining({ externalUserId: "requester" }),
    );
  });
});
