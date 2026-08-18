import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createTestApp } from "./test-app.js";

const PROJECT_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const apps: ReturnType<typeof createTestApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const publication = {
  slug: "acme-deck",
  projectId: PROJECT_ID,
  path: "store/decks/sam/acme.md",
  audience: "public",
  createdBy: "sam",
  createdAt: "2026-08-18T00:00:00.000Z",
  revokedAt: null,
};

function coreStub(resolveResult: unknown) {
  const reads: unknown[] = [];
  return {
    reads,
    core: {
      publications: {
        publish: async () => publication,
        list: async () => [publication],
        revoke: async () => {},
        resolve: async (input: unknown) => {
          reads.push(input);
          return resolveResult;
        },
      },
      documents: {
        readBytes: async (input: unknown) => {
          reads.push(input);
          return {
            path: "store/decks/sam/acme.md",
            source: "store",
            contentType: "text/markdown",
            size: 11,
            version: 2,
            bytes: new TextEncoder().encode("# Acme deck"),
          };
        },
      },
    } as never,
  };
}

describe("publication routes (ADR 0055)", () => {
  it("publish / list / revoke, with the audience's URL", async () => {
    const { core } = coreStub(null);
    const app = createTestApp({ core });
    apps.push(app);
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/publications`,
      payload: {
        path: "store/decks/sam/acme.md",
        audience: "public",
        slug: "acme-deck",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().url).toBe(`/public/${PROJECT_ID}/acme-deck`);
    const list = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/publications`,
    });
    expect(list.json()[0]).toMatchObject({ slug: "acme-deck" });
    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/projects/${PROJECT_ID}/publications/acme-deck`,
    });
    expect(revoked.statusCode).toBe(204);
  });

  it("serves a public publication with no identity at all, as the anonymous document-scoped identity", async () => {
    const anonymous = {
      identity: {
        tenantId: "t",
        externalUserId: "public:acme-deck",
        scope: [
          {
            kind: "document",
            projectId: PROJECT_ID,
            path: "store/decks/sam/acme.md",
          },
        ],
      },
      path: "store/decks/sam/acme.md",
      audience: "public",
    };
    const { core, reads } = coreStub(anonymous);
    // A strict resolver: nobody is signed in.
    const app = createApp({ core, identity: () => null });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/public/${PROJECT_ID}/acme-deck`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/markdown");
    expect(response.headers["x-catamorphic-document-version"]).toBe("2");
    expect(response.body).toBe("# Acme deck");
    expect(reads[0]).toMatchObject({ slug: "acme-deck", caller: null });
    expect(reads[1]).toMatchObject({
      identity: anonymous.identity,
      path: "store/decks/sam/acme.md",
    });
    // Everything else on the plugin still requires identity.
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${PROJECT_ID}/publications`,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${PROJECT_ID}/documents`,
        })
      ).statusCode,
    ).toBe(401);
  });

  it("unknown, revoked, or not-for-you publications are one uniform 404", async () => {
    const { core } = coreStub(null);
    const app = createApp({ core, identity: () => null });
    apps.push(app);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/public/${PROJECT_ID}/nope`,
        })
      ).statusCode,
    ).toBe(404);
    const signed = createTestApp({ core });
    apps.push(signed);
    expect(
      (
        await signed.inject({
          method: "GET",
          url: `/api/projects/${PROJECT_ID}/publications/nope`,
        })
      ).statusCode,
    ).toBe(404);
  });
});
