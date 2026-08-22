import { randomBytes } from "node:crypto";
import type { DB } from "@catamorphic/db";
import type { Kysely } from "kysely";
import {
  type DocumentRef,
  type Identity,
  isBuilder,
  mayUseProject,
} from "../identity.js";
import { AccessDeniedError } from "./artifact-scope.js";
import {
  documentAccessAllowed,
  normalizeDocumentPath,
} from "./documents-service.js";
import { requireTenantProject } from "./projects-service.js";

/**
 * Publications (ADR 0055): a document served at a stable URL to an
 * audience — `members` (whoever may use the project, through the host's
 * own auth) or `public` (an anonymous, read-only identity scoped to exactly
 * this one document; the only non-host identity there is). A publication
 * is a *pointer*: the document keeps living in the program or the store,
 * so a later write is what readers see, and revoking is a timestamp.
 *
 * Who may publish: builders (anything they may read), and members for
 * store documents they may write — a CSM shares their own deck, not the
 * handbook. Hosts narrow further through roles (no write, no publish).
 */
export type PublicationAudience = "public" | "members";

export interface Publication {
  slug: string;
  projectId: string;
  path: string;
  audience: PublicationAudience;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
}

export class PublicationSlugError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationSlugError";
  }
}

/** The slug is already used in this project (revoked ones keep theirs). */
export class PublicationSlugTakenError extends Error {
  constructor(readonly slug: string) {
    super(`Publication slug '${slug}' is already used in this project`);
    this.name = "PublicationSlugTakenError";
  }
}

export class PublicationNotFoundError extends Error {
  constructor(readonly slug: string) {
    super(`Publication '${slug}' not found`);
    this.name = "PublicationNotFoundError";
  }
}

const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class PublicationsService {
  constructor(private readonly db: Kysely<DB>) {}

  async publish(input: {
    identity: Identity;
    projectId: string;
    path: string;
    audience: PublicationAudience;
    /** Optional readable handle; random when omitted. */
    slug?: string;
  }): Promise<Publication> {
    const { identity, projectId } = input;
    await this.requireProject(identity, projectId);
    const path = normalizeDocumentPath(input.path);
    // Builders publish what they may read (the program; store paths their
    // document refs cover). Members publish what they may WRITE — their own
    // store documents — never the program.
    const mayPublish =
      documentAccessAllowed(identity, projectId, path, "read") &&
      (isBuilder(identity, projectId) ||
        documentAccessAllowed(identity, projectId, path, "write"));
    if (!mayPublish) throw new AccessDeniedError();
    const slug = input.slug ?? randomSlug();
    if (!SLUG_PATTERN.test(slug)) {
      throw new PublicationSlugError(
        "Publication slug must be 1-64 letters, digits, '.', '_' or '-'",
      );
    }
    try {
      const row = await this.db
        .insertInto("publications")
        .values({
          project_id: projectId,
          slug,
          path,
          audience: input.audience,
          created_by: identity.externalUserId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return mapPublication(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new PublicationSlugTakenError(slug);
      throw error;
    }
  }

  /** Builders see every publication; members their own. */
  async list(input: {
    identity: Identity;
    projectId: string;
  }): Promise<Publication[]> {
    await this.requireProject(input.identity, input.projectId);
    let query = this.db
      .selectFrom("publications")
      .where("project_id", "=", input.projectId);
    if (!isBuilder(input.identity, input.projectId)) {
      query = query.where("created_by", "=", input.identity.externalUserId);
    }
    const rows = await query
      .selectAll()
      .orderBy("created_at", "desc")
      .execute();
    return rows.map(mapPublication);
  }

  /** The publisher or a builder may revoke. */
  async revoke(input: {
    identity: Identity;
    projectId: string;
    slug: string;
  }): Promise<void> {
    await this.requireProject(input.identity, input.projectId);
    const row = await this.db
      .selectFrom("publications")
      .where("project_id", "=", input.projectId)
      .where("slug", "=", input.slug)
      .selectAll()
      .executeTakeFirst();
    if (!row) throw new PublicationNotFoundError(input.slug);
    if (
      !isBuilder(input.identity, input.projectId) &&
      row.created_by !== input.identity.externalUserId
    ) {
      throw new AccessDeniedError();
    }
    await this.db
      .updateTable("publications")
      .set({ revoked_at: new Date() })
      .where("id", "=", row.id)
      .execute();
  }

  /**
   * Resolve a live publication for serving. Returns the identity to read
   * the document AS: for `public`, an anonymous identity scoped to exactly
   * this document; for `members`, the caller narrowed to it (the
   * publication grants the read, whatever the member's own refs say) —
   * `null` when the slug is unknown, revoked, or the audience does not
   * admit this caller.
   */
  async resolve(input: {
    projectId: string;
    slug: string;
    /** The authenticated caller, or null for anonymous requests. */
    caller: Identity | null;
  }): Promise<{
    identity: Identity;
    path: string;
    audience: PublicationAudience;
  } | null> {
    const row = await this.db
      .selectFrom("publications")
      .innerJoin("projects", "projects.id", "publications.project_id")
      .where("publications.project_id", "=", input.projectId)
      .where("publications.slug", "=", input.slug)
      .where("publications.revoked_at", "is", null)
      .select([
        "publications.path",
        "publications.audience",
        "publications.slug",
        "projects.tenant_id",
      ])
      .executeTakeFirst();
    if (!row) return null;
    const audience = row.audience as PublicationAudience;
    const ref: DocumentRef = {
      kind: "document",
      projectId: input.projectId,
      path: row.path,
    };
    if (audience === "public") {
      return {
        identity: {
          tenantId: row.tenant_id,
          externalUserId: `public:${row.slug}`,
          scope: [ref],
        },
        path: row.path,
        audience,
      };
    }
    if (!input.caller || input.caller.tenantId !== row.tenant_id) return null;
    if (!mayUseProject(input.caller, input.projectId)) return null;
    return {
      identity: { ...input.caller, scope: [ref] },
      path: row.path,
      audience,
    };
  }

  private requireProject(identity: Identity, projectId: string) {
    return requireTenantProject(this.db, identity.tenantId, projectId);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

function randomSlug(): string {
  // Hex preserves 72 bits of entropy while guaranteeing the first character
  // satisfies SLUG_PATTERN. Base64url can begin with "-" or "_".
  return randomBytes(9).toString("hex");
}

function mapPublication(row: {
  slug: string;
  project_id: string;
  path: string;
  audience: string;
  created_by: string;
  created_at: Date;
  revoked_at: Date | null;
}): Publication {
  return {
    slug: row.slug,
    projectId: row.project_id,
    path: row.path,
    audience: row.audience as PublicationAudience,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  };
}
