import { randomBytes } from "node:crypto";
import {
  type CatamorphicCore,
  hasProjectPermission,
  type Identity,
  identityMayUseEnvironment,
  normalizeDocumentPath,
} from "@catamorphic/core";
import type { DB } from "@catamorphic/db";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import type { WorkAuth, WorkAuthUser } from "../auth/work-auth.js";

export type ShareKind = "document" | "folder" | "app";

export interface Share {
  id: string;
  projectId: string;
  kind: ShareKind;
  target: string;
  environment: string | null;
  title: string;
  audience: { emails: string[]; domains: string[] };
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  url: string;
}

export const CreateShareSchema = z.strictObject({
  kind: z.enum(["document", "folder", "app"]),
  target: z.string().trim().min(1).max(512),
  /** App shares: the Environment the app's workflows run in for viewers. */
  environment: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  audience: z
    .strictObject({
      emails: z.array(z.email().toLowerCase()).max(200).default([]),
      domains: z
        .array(
          z
            .string()
            .trim()
            .toLowerCase()
            .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/),
        )
        .max(50)
        .default([]),
    })
    .refine(
      (audience) => audience.emails.length + audience.domains.length > 0,
      "Name at least one email or domain",
    ),
  expiresAt: z.iso.datetime().optional(),
});
export type CreateShareInput = z.infer<typeof CreateShareSchema>;

export class ShareAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShareAccessError";
  }
}

/**
 * Shares (ADR 0165): one document, folder, or app of a project, addressed to
 * people or email domains outside it. A viewer signs in, and the server
 * derives a confined identity that can read exactly the shared thing (or run
 * exactly the shared app) and nothing else: no permissions, no agents, no
 * other project content. Guests (accounts from guest providers) can only
 * ever act through shares.
 */
export class WorkSharesService {
  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      core: CatamorphicCore;
      auth: Pick<WorkAuth, "accountsFor">;
      guestProviderIds: () => Set<string>;
      tenantId: string;
      publicBase: string;
    },
  ) {}

  async create(args: {
    identity: Identity;
    projectId: string;
    input: CreateShareInput;
  }): Promise<Share> {
    const { identity, projectId, input } = args;
    if (!hasProjectPermission(identity, projectId, "publications:write")) {
      throw new ShareAccessError("Sharing needs publications:write");
    }
    const target = await this.validateTarget({ identity, projectId, input });
    if (input.environment) {
      if (input.kind !== "app") {
        throw new ShareAccessError("Only app shares name an Environment");
      }
      if (!identityMayUseEnvironment(identity, projectId, input.environment)) {
        throw new ShareAccessError(
          `You may not grant the Environment '${input.environment}'`,
        );
      }
    }
    const id = randomBytes(16).toString("base64url");
    const row = await this.deps.db
      .insertInto("work_shares")
      .values({
        id,
        project_id: projectId,
        kind: input.kind,
        target,
        environment: input.environment ?? null,
        title: input.title ?? target,
        audience_emails: JSON.stringify([...new Set(input.audience.emails)]),
        audience_domains: JSON.stringify([...new Set(input.audience.domains)]),
        created_by: identity.externalUserId,
        expires_at: input.expiresAt ? new Date(input.expiresAt) : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.toShare(row);
  }

  async list(args: {
    identity: Identity;
    projectId: string;
  }): Promise<Share[]> {
    if (
      !hasProjectPermission(args.identity, args.projectId, "publications:read")
    ) {
      throw new ShareAccessError("Listing shares needs publications:read");
    }
    const rows = await this.deps.db
      .selectFrom("work_shares")
      .selectAll()
      .where("project_id", "=", args.projectId)
      .orderBy("created_at", "desc")
      .execute();
    return rows.map((row) => this.toShare(row));
  }

  async revoke(args: {
    identity: Identity;
    projectId: string;
    shareId: string;
  }): Promise<boolean> {
    if (
      !hasProjectPermission(args.identity, args.projectId, "publications:write")
    ) {
      throw new ShareAccessError("Revoking shares needs publications:write");
    }
    const row = await this.deps.db
      .updateTable("work_shares")
      .set({ revoked_at: sql`now()` })
      .where("id", "=", args.shareId)
      .where("project_id", "=", args.projectId)
      .where("revoked_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    return Boolean(row);
  }

  /** Accounts that exist only through guest providers never get membership. */
  async isGuest(userId: string): Promise<boolean> {
    const guestProviders = this.deps.guestProviderIds();
    if (guestProviders.size === 0) return false;
    const accounts = await this.deps.auth.accountsFor({ userId });
    return (
      accounts.length > 0 &&
      accounts.every((account) => guestProviders.has(account.providerId))
    );
  }

  /**
   * The share and a confined identity for one signed-in viewer, or null.
   * Unknown, revoked, expired, and not-addressed-to-you all look the same.
   */
  async open(args: {
    shareId: string;
    viewer: WorkAuthUser;
  }): Promise<{ share: Share; identity: Identity } | null> {
    const row = await this.deps.db
      .selectFrom("work_shares")
      .innerJoin("projects", "projects.id", "work_shares.project_id")
      .selectAll("work_shares")
      .where("work_shares.id", "=", args.shareId)
      .where("projects.tenant_id", "=", this.deps.tenantId)
      .where("work_shares.revoked_at", "is", null)
      .where(({ or, eb }) =>
        or([
          eb("work_shares.expires_at", "is", null),
          eb("work_shares.expires_at", ">", sql<Date>`now()`),
        ]),
      )
      .executeTakeFirst();
    if (!row) return null;
    const share = this.toShare(row);
    if (!(await this.addressedTo({ share, viewer: args.viewer }))) return null;
    const ref =
      share.kind === "app"
        ? {
            kind: "app" as const,
            projectId: share.projectId,
            name: share.target,
          }
        : {
            kind: "document" as const,
            projectId: share.projectId,
            path: share.kind === "folder" ? `${share.target}/**` : share.target,
            access: "read" as const,
          };
    return {
      share,
      identity: {
        tenantId: this.deps.tenantId,
        externalUserId: args.viewer.id,
        scope: [ref],
        projectPermissions: [],
        connectionScope: [],
        executionScope: share.environment
          ? [{ projectId: share.projectId, name: share.environment }]
          : [],
      },
    };
  }

  async record(args: {
    shareId: string;
    viewer: WorkAuthUser;
    action: string;
    detail?: string;
  }): Promise<void> {
    await this.deps.db
      .insertInto("work_share_events")
      .values({
        share_id: args.shareId,
        viewer_user_id: args.viewer.id,
        viewer_email: args.viewer.email,
        action: args.action,
        detail: args.detail ?? null,
      })
      .execute();
  }

  private async addressedTo(args: {
    share: Share;
    viewer: WorkAuthUser;
  }): Promise<boolean> {
    const email = args.viewer.email.toLowerCase();
    if (args.viewer.emailVerified) {
      const domain = email.split("@").at(-1) ?? "";
      if (
        args.share.audience.emails.includes(email) ||
        args.share.audience.domains.includes(domain)
      ) {
        return true;
      }
    }
    // Members who manage the project's shares may open them to check.
    if (await this.isGuest(args.viewer.id)) return false;
    const member = await this.deps.core.memberships.identityFor({
      tenantId: this.deps.tenantId,
      projectId: args.share.projectId,
      externalUserId: args.viewer.id,
    });
    return Boolean(
      member &&
        hasProjectPermission(member, args.share.projectId, "publications:read"),
    );
  }

  private async validateTarget(args: {
    identity: Identity;
    projectId: string;
    input: CreateShareInput;
  }): Promise<string> {
    const { identity, projectId, input } = args;
    if (input.kind === "app") {
      const state = await this.deps.core.apps
        ?.viewState({
          identity,
          projectId,
          appName: input.target,
          metadataOnly: true,
        })
        .catch(() => undefined);
      if (state?.state !== "ready") {
        throw new ShareAccessError(
          `App '${input.target}' has no published version you can open`,
        );
      }
      return input.target;
    }
    const path = normalizeDocumentPath(input.target.replace(/\/\*\*$/, ""));
    if (input.kind === "document") {
      // The creator must be able to read what they share.
      await this.deps.core.documents.read({ identity, projectId, path });
      return path;
    }
    const entries = await this.deps.core.documents.list({
      identity,
      projectId,
      prefix: path,
    });
    if (entries.length === 0) {
      throw new ShareAccessError(`No files you can read under '${path}'`);
    }
    return path;
  }

  private toShare(row: {
    id: string;
    project_id: string;
    kind: string;
    target: string;
    environment: string | null;
    title: string;
    audience_emails: unknown;
    audience_domains: unknown;
    created_by: string;
    created_at: Date;
    expires_at: Date | null;
    revoked_at: Date | null;
  }): Share {
    const strings = (value: unknown) =>
      Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];
    const kind: ShareKind =
      row.kind === "app" || row.kind === "folder" ? row.kind : "document";
    return {
      id: row.id,
      projectId: row.project_id,
      kind,
      target: row.target,
      environment: row.environment,
      title: row.title,
      audience: {
        emails: strings(row.audience_emails),
        domains: strings(row.audience_domains),
      },
      createdBy: row.created_by,
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at?.toISOString() ?? null,
      revokedAt: row.revoked_at?.toISOString() ?? null,
      url: `${this.deps.publicBase}/s/${row.id}`,
    };
  }
}
