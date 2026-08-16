import type { DB } from "@catamorphic/db";
import type { Kysely } from "kysely";
import { type Identity, scopeCovers } from "../identity.js";
import { AppNotFoundError } from "./apps-service.js";

/**
 * Serialized-snapshot cap. App-local storage is for this user's todos,
 * drafts, and view preferences — not a database. Browsers give localStorage
 * ~5MB; a deliberately smaller quota keeps guest-doc seeding (the snapshot
 * is baked into the served document) and per-write uploads cheap.
 */
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const MAX_KEYS = 512;

export class AppStorageSnapshotTooLargeError extends Error {
  constructor() {
    super(
      `App storage snapshot exceeds the quota (${MAX_KEYS} keys / ${
        MAX_SNAPSHOT_BYTES / 1024
      }KB). App-local storage is for small UI state; larger or shared data belongs behind workflows.`,
    );
    this.name = "AppStorageSnapshotTooLargeError";
  }
}

/**
 * Persistent app-local storage: the durable backing of the guest runtime's
 * localStorage shim (ADR 0037's opaque-origin sandbox has no native
 * storage). One flat string map per (app, user) — seeded into the guest
 * document at serve time, written back through the mount's authenticated
 * channel. Isolation is structural: rows are keyed by the caller's own
 * `externalUserId`, and the app row is resolved through the caller's
 * tenant+project, so no identity can read or write anyone else's snapshot.
 * A scoped identity additionally has to cover the app (ADR 0053).
 */
export class AppStorageService {
  constructor(private readonly db: Kysely<DB>) {}

  /** The caller's snapshot for an app; empty when none exists. */
  async get(
    identity: Identity,
    projectId: string,
    appName: string,
  ): Promise<{ data: Record<string, string>; revision: string }> {
    const app = await this.appRow(identity, projectId, appName);
    if (!app) return { data: {}, revision: "0" };
    const row = await this.db
      .selectFrom("app_storage")
      .where("app_id", "=", app.id)
      .where("external_user_id", "=", identity.externalUserId)
      .select(["data", "updated_at"])
      .executeTakeFirst();
    if (!row) return { data: {}, revision: "0" };
    return {
      data: sanitizeSnapshot(row.data),
      revision: row.updated_at.getTime().toString(36),
    };
  }

  /** Replace the caller's snapshot (last write wins, like localStorage). */
  async put(
    identity: Identity,
    projectId: string,
    appName: string,
    data: Record<string, string>,
  ): Promise<void> {
    assertWithinQuota(data);
    const app = await this.appRow(identity, projectId, appName);
    if (!app) throw new AppNotFoundError(appName);
    await this.db
      .insertInto("app_storage")
      .values({
        app_id: app.id,
        external_user_id: identity.externalUserId,
        data: JSON.stringify(data),
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc.columns(["app_id", "external_user_id"]).doUpdateSet({
          data: JSON.stringify(data),
          updated_at: new Date(),
        }),
      )
      .execute();
  }

  private appRow(identity: Identity, projectId: string, appName: string) {
    if (
      identity.scope !== undefined &&
      !scopeCovers(identity.scope, { kind: "app", projectId, name: appName })
    ) {
      return Promise.resolve(undefined);
    }
    return this.db
      .selectFrom("apps")
      .innerJoin("projects", "projects.id", "apps.project_id")
      .where("projects.tenant_id", "=", identity.tenantId)
      .where("apps.project_id", "=", projectId)
      .where("apps.name", "=", appName)
      .select(["apps.id"])
      .executeTakeFirst();
  }
}

function assertWithinQuota(data: Record<string, string>): void {
  const keys = Object.keys(data);
  if (keys.length > MAX_KEYS) throw new AppStorageSnapshotTooLargeError();
  let bytes = 0;
  for (const key of keys) {
    const value = data[key];
    if (typeof value !== "string") throw new AppStorageSnapshotTooLargeError();
    bytes += key.length + value.length;
    if (bytes > MAX_SNAPSHOT_BYTES) {
      throw new AppStorageSnapshotTooLargeError();
    }
  }
}

/** Stored jsonb is ours, but stay paranoid: only flat string entries leave. */
function sanitizeSnapshot(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
