import { createHash } from "node:crypto";
import type { DB, Json } from "@catamorphic/db";
import { type Kysely, sql, type Transaction } from "kysely";
import {
  type Identity,
  identityMayUseEnvironment,
  isProjectPrincipal,
  mayUseProject,
} from "../identity.js";
import { AccessDeniedError } from "./artifact-scope.js";
import type { CredentialVault } from "./credential-vault.js";
import type { ProjectEnvironmentsService } from "./project-environments-service.js";
import { requireTenantProject } from "./projects-service.js";
import { toJson } from "./run-coordinator.js";

/*
 * A member's personal environment for one project (ADR 0184): the files
 * they listed in `.work/personal/environment.json`, and their own setup
 * command (ADR 0207). Harness sign-ins are never sent here; they stay on
 * the machine they were made on (ADR 0199).
 * File values
 * are sealed in the credential vault; rows hold references, fingerprints,
 * and sizes. Only the member reads or replaces their own set, and no API
 * returns a file's value: core unseals it only to deliver it into that
 * member's own chats' sandboxes. The setup command is not secret, so it is
 * kept as text, but it too is the member's alone and runs only there.
 */

/** At most this many personal files per member and project. */
export const PERSONAL_FILES_MAX = 50;
/** The largest personal file. */
export const PERSONAL_FILE_MAX_BYTES = 256 * 1024;
/** The longest personal setup command, as long as an Environment's. */
export const PERSONAL_SETUP_MAX_LENGTH = 16_384;
/** What a member's desktop sends: files and setup, replacing the set. */
export interface PersonalEnvironmentInput {
  /** Repository-relative files; `content` is base64. */
  files: ReadonlyArray<{ path: string; content: string }>;
  /**
   * Run after the Environment's setup in each new workspace of the
   * member's own chats (ADR 0207). Absent or blank, none.
   */
  setup?: string;
}

export interface PersonalFileStatus {
  path: string;
  fingerprint: string;
  bytes: number;
  updatedAt: string;
}

/** What the server holds for the caller. Never a file's value. */
export interface PersonalEnvironmentStatus {
  /** Some Environment of the project gives this member's chats their credentials. */
  allowed: boolean;
  files: PersonalFileStatus[];
  /** The member's own setup command (ADR 0207), shown back to them. */
  setup: { command: string; updatedAt: string } | null;
}

/** The member's files, unsealed for delivery into a sandbox. */
export interface UnsealedPersonalEnvironment {
  files: Array<{ path: string; content: Buffer; fingerprint: string }>;
}

/** The desktop sent something the server will not keep; each issue says why. */
export class PersonalEnvironmentInvalidError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(issues.join("; "));
    this.name = "PersonalEnvironmentInvalidError";
  }
}

/** A server without a credential vault cannot hold personal credentials. */
export class PersonalEnvironmentUnavailableError extends Error {
  constructor() {
    super(
      "This server has no credential vault, so it cannot hold personal credentials",
    );
    this.name = "PersonalEnvironmentUnavailableError";
  }
}

/**
 * Why a repository path cannot hold a personal file, or undefined. Paths
 * are relative to the project root, use `/`, and never climb out of it or
 * into Git's own directory.
 */
export function personalFilePathProblem(path: string): string | undefined {
  if (path.length === 0) return "A file path is empty";
  if (path.length > 512) return `${path.slice(0, 40)}...: the path is too long`;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them
  if (/[\u0000-\u001f\u007f]/.test(path))
    return `${JSON.stringify(path)}: the path holds control characters`;
  if (path.includes("\\"))
    return `${path}: use / between folders, not backslashes`;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path))
    return `${path}: the path must be relative to the project folder`;
  const segments = path.split("/");
  if (segments.some((segment) => segment === ""))
    return `${path}: the path has an empty folder name`;
  if (segments.some((segment) => segment === "." || segment === ".."))
    return `${path}: the path may not use . or ..`;
  if (segments.some((segment) => segment.toLowerCase() === ".git"))
    return `${path}: files under .git are Git's own`;
  return undefined;
}

/** Why a personal setup command cannot be kept, or undefined. */
export function personalSetupProblem(command: string): string | undefined {
  if (command.length > PERSONAL_SETUP_MAX_LENGTH)
    return `The setup command is longer than ${PERSONAL_SETUP_MAX_LENGTH} characters`;
  if (command.includes("\u0000"))
    return "The setup command holds a NUL character";
  return undefined;
}

/** `sha256:<hex>` of the bytes: names content without revealing it. */
export function personalFingerprint(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

interface ValidEntry {
  kind: "file";
  name: string;
  content: Buffer;
}

/** Check a desktop's set and turn it into entries, or refuse it whole. */
export function validatePersonalEnvironment(
  input: PersonalEnvironmentInput,
): ValidEntry[] {
  const issues: string[] = [];
  const entries: ValidEntry[] = [];
  if (input.files.length > PERSONAL_FILES_MAX)
    issues.push(`At most ${PERSONAL_FILES_MAX} files may be included`);
  const seen = new Set<string>();
  for (const file of input.files.slice(0, PERSONAL_FILES_MAX)) {
    const problem = personalFilePathProblem(file.path);
    if (problem) {
      issues.push(problem);
      continue;
    }
    if (seen.has(file.path)) {
      issues.push(`${file.path} is listed twice`);
      continue;
    }
    seen.add(file.path);
    if (
      file.content.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)
    ) {
      issues.push(`${file.path}: the content is not base64`);
      continue;
    }
    const content = Buffer.from(file.content, "base64");
    if (content.byteLength > PERSONAL_FILE_MAX_BYTES) {
      issues.push(`${file.path} is larger than 256 KiB`);
      continue;
    }
    entries.push({ kind: "file", name: file.path, content });
  }
  const setupProblem =
    input.setup === undefined ? undefined : personalSetupProblem(input.setup);
  if (setupProblem) issues.push(setupProblem);
  if (issues.length > 0) throw new PersonalEnvironmentInvalidError(issues);
  return entries;
}

/**
 * Keep, replace or drop a member's setup command; reports the change for
 * the audit by fingerprint, like files.
 */
async function replaceSetup(input: {
  trx: Transaction<DB>;
  owner: { tenant_id: string; project_id: string; external_user_id: string };
  command: string | undefined;
}): Promise<{
  changed?: { kind: string; name: string; fingerprint: string };
  removed: boolean;
}> {
  const { trx, owner, command } = input;
  const current = await trx
    .selectFrom("personal_environment_setups")
    .select("command")
    .where("tenant_id", "=", owner.tenant_id)
    .where("project_id", "=", owner.project_id)
    .where("external_user_id", "=", owner.external_user_id)
    .executeTakeFirst();
  if (command === undefined) {
    if (!current) return { removed: false };
    await trx
      .deleteFrom("personal_environment_setups")
      .where("tenant_id", "=", owner.tenant_id)
      .where("project_id", "=", owner.project_id)
      .where("external_user_id", "=", owner.external_user_id)
      .execute();
    return { removed: true };
  }
  if (current?.command === command) return { removed: false };
  await trx
    .insertInto("personal_environment_setups")
    .values({ ...owner, command, updated_at: new Date() })
    .onConflict((conflict) =>
      conflict
        .columns(["tenant_id", "project_id", "external_user_id"])
        .doUpdateSet({ command, updated_at: new Date() }),
    )
    .execute();
  return {
    changed: {
      kind: "setup",
      name: "setup",
      fingerprint: personalFingerprint(command),
    },
    removed: false,
  };
}

/** Serialize one member's changes to their set for a project. */
async function lockMember(input: {
  trx: Transaction<DB>;
  identity: Identity;
  projectId: string;
}): Promise<void> {
  const lock = `personal-environment:${input.identity.tenantId}:${input.projectId}:${input.identity.externalUserId}`;
  await sql`select pg_advisory_xact_lock(hashtextextended(${lock}, 0))`.execute(
    input.trx,
  );
}

export class PersonalEnvironmentService {
  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      vault?: CredentialVault;
      environments: ProjectEnvironmentsService;
    },
  ) {}

  private async requireMember(identity: Identity, projectId: string) {
    await requireTenantProject(this.deps.db, identity.tenantId, projectId);
    if (
      !mayUseProject(identity, projectId) ||
      isProjectPrincipal(identity.externalUserId)
    )
      throw new AccessDeniedError();
  }

  /** Replace the caller's whole set for the project. */
  async replace(args: {
    identity: Identity;
    projectId: string;
    input: PersonalEnvironmentInput;
  }): Promise<PersonalEnvironmentStatus> {
    const { identity, projectId } = args;
    await this.requireMember(identity, projectId);
    const vault = this.deps.vault;
    if (!vault) throw new PersonalEnvironmentUnavailableError();
    const entries = validatePersonalEnvironment(args.input);
    const owner = {
      tenant_id: identity.tenantId,
      project_id: projectId,
      external_user_id: identity.externalUserId,
    };
    const key = (entry: { kind: string; name: string }) =>
      `${entry.kind}\u0000${entry.name}`;
    // One member's replacements take turns, so each releases exactly the
    // records it displaced and none is left sealed without a row.
    const sealed: string[] = [];
    let outcome: {
      released: string[];
      changed: Array<{ kind: string; name: string; fingerprint: string }>;
      removed: Array<{ kind: string; name: string }>;
    };
    try {
      outcome = await this.deps.db.transaction().execute(async (trx) => {
        await lockMember({ trx, identity, projectId });
        const current = await trx
          .selectFrom("personal_environment_entries")
          .selectAll()
          .where("tenant_id", "=", owner.tenant_id)
          .where("project_id", "=", projectId)
          .where("external_user_id", "=", owner.external_user_id)
          .execute();
        const existing = new Map(current.map((row) => [key(row), row]));
        const released: string[] = [];
        const changed: Array<{
          kind: string;
          name: string;
          fingerprint: string;
        }> = [];
        for (const entry of entries) {
          const fingerprint = personalFingerprint(entry.content);
          const previous = existing.get(key(entry));
          if (previous?.fingerprint === fingerprint) continue;
          const record = await vault.put({
            tenantId: identity.tenantId,
            // A plain copy: a Buffer's slices share its memory, and vaults
            // zero what they hand out.
            material: new Uint8Array(entry.content),
          });
          sealed.push(record.id);
          await trx
            .insertInto("personal_environment_entries")
            .values({
              ...owner,
              kind: entry.kind,
              name: entry.name,
              credential_ref: record.id,
              fingerprint,
              bytes: entry.content.byteLength,
              expires_at: null,
              updated_at: new Date(),
            })
            .onConflict((conflict) =>
              conflict
                .columns([
                  "tenant_id",
                  "project_id",
                  "external_user_id",
                  "kind",
                  "name",
                ])
                .doUpdateSet({
                  credential_ref: record.id,
                  fingerprint,
                  bytes: entry.content.byteLength,
                  updated_at: new Date(),
                }),
            )
            .execute();
          if (previous) released.push(previous.credential_ref);
          changed.push({ kind: entry.kind, name: entry.name, fingerprint });
        }
        const kept = new Set(entries.map(key));
        const removed = current.filter((row) => !kept.has(key(row)));
        for (const row of removed) {
          await trx
            .deleteFrom("personal_environment_entries")
            .where("tenant_id", "=", row.tenant_id)
            .where("project_id", "=", row.project_id)
            .where("external_user_id", "=", row.external_user_id)
            .where("kind", "=", row.kind)
            .where("name", "=", row.name)
            .execute();
          released.push(row.credential_ref);
        }
        const setup = await replaceSetup({
          trx,
          owner,
          command: args.input.setup?.trim() ? args.input.setup : undefined,
        });
        return {
          released,
          changed: [...changed, ...(setup.changed ? [setup.changed] : [])],
          removed: [
            ...removed.map((row) => ({ kind: row.kind, name: row.name })),
            ...(setup.removed ? [{ kind: "setup", name: "setup" }] : []),
          ],
        };
      });
    } catch (error) {
      for (const id of sealed)
        await vault
          .delete({ tenantId: identity.tenantId, ref: { id } })
          .catch(() => {});
      throw error;
    }
    const { released, changed, removed } = outcome;
    for (const ref of released)
      await vault
        .delete({ tenantId: identity.tenantId, ref: { id: ref } })
        .catch(() => {});
    if (changed.length > 0 || removed.length > 0)
      await this.audit({
        identity,
        projectId,
        eventType: "personal_environment.replace",
        metadata: {
          changed: changed.map(({ kind, name, fingerprint }) => ({
            kind,
            name,
            fingerprint,
          })),
          removed,
        },
      });
    return this.status({ identity, projectId });
  }

  /** What the server holds for the caller, without any value. */
  async status(args: {
    identity: Identity;
    projectId: string;
  }): Promise<PersonalEnvironmentStatus> {
    const { identity, projectId } = args;
    await this.requireMember(identity, projectId);
    const rows = await this.deps.db
      .selectFrom("personal_environment_entries")
      .select(["kind", "name", "fingerprint", "bytes", "updated_at"])
      .where("tenant_id", "=", identity.tenantId)
      .where("project_id", "=", projectId)
      .where("external_user_id", "=", identity.externalUserId)
      .execute();
    // Byte order, whatever the database's collation.
    rows.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    const setup = await this.deps.db
      .selectFrom("personal_environment_setups")
      .select(["command", "updated_at"])
      .where("tenant_id", "=", identity.tenantId)
      .where("project_id", "=", projectId)
      .where("external_user_id", "=", identity.externalUserId)
      .executeTakeFirst();
    return {
      allowed: await this.allowed(identity, projectId),
      files: rows
        .filter((row) => row.kind === "file")
        .map((row) => ({
          path: row.name,
          fingerprint: row.fingerprint,
          bytes: row.bytes,
          updatedAt: row.updated_at.toISOString(),
        })),
      setup: setup
        ? {
            command: setup.command,
            updatedAt: setup.updated_at.toISOString(),
          }
        : null,
    };
  }

  /** Forget everything the caller sent for the project. */
  async remove(args: { identity: Identity; projectId: string }): Promise<void> {
    const { identity, projectId } = args;
    await this.requireMember(identity, projectId);
    const { rows, setup } = await this.deps.db
      .transaction()
      .execute(async (trx) => {
        await lockMember({ trx, identity, projectId });
        const rows = await trx
          .deleteFrom("personal_environment_entries")
          .where("tenant_id", "=", identity.tenantId)
          .where("project_id", "=", projectId)
          .where("external_user_id", "=", identity.externalUserId)
          .returning(["kind", "name", "credential_ref"])
          .execute();
        const setup = await trx
          .deleteFrom("personal_environment_setups")
          .where("tenant_id", "=", identity.tenantId)
          .where("project_id", "=", projectId)
          .where("external_user_id", "=", identity.externalUserId)
          .returning("command")
          .executeTakeFirst();
        return { rows, setup };
      });
    for (const row of rows)
      await this.deps.vault
        ?.delete({
          tenantId: identity.tenantId,
          ref: { id: row.credential_ref },
        })
        .catch(() => {});
    if (rows.length > 0 || setup)
      await this.audit({
        identity,
        projectId,
        eventType: "personal_environment.remove",
        metadata: {
          removed: [
            ...rows.map((row) => ({ kind: row.kind, name: row.name })),
            ...(setup ? [{ kind: "setup", name: "setup" }] : []),
          ],
        },
      });
  }

  /**
   * The owner's own setup command, for a workspace of one of their own
   * chats (ADR 0207). Host-only: never an API.
   */
  async setup(args: {
    tenantId: string;
    projectId: string;
    owner: string;
  }): Promise<string | undefined> {
    const row = await this.deps.db
      .selectFrom("personal_environment_setups")
      .select("command")
      .where("tenant_id", "=", args.tenantId)
      .where("project_id", "=", args.projectId)
      .where("external_user_id", "=", args.owner)
      .executeTakeFirst();
    return row?.command;
  }

  /**
   * The owner's files, unsealed for delivery into one of their own chats'
   * sandboxes. Host-only: never an API.
   */
  async unseal(args: {
    tenantId: string;
    projectId: string;
    owner: string;
  }): Promise<UnsealedPersonalEnvironment> {
    const result: UnsealedPersonalEnvironment = { files: [] };
    const vault = this.deps.vault;
    if (!vault) return result;
    const rows = await this.deps.db
      .selectFrom("personal_environment_entries")
      .selectAll()
      .where("tenant_id", "=", args.tenantId)
      .where("project_id", "=", args.projectId)
      .where("external_user_id", "=", args.owner)
      .where("kind", "=", "file")
      .execute();
    rows.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const row of rows) {
      const content = await vault.withMaterial({
        tenantId: args.tenantId,
        ref: { id: row.credential_ref },
        use: (material) => Buffer.from(material),
      });
      result.files.push({
        path: row.name,
        content,
        fingerprint: row.fingerprint,
      });
    }
    return result;
  }

  /** Audit a delivery into a sandbox: names and fingerprints only. */
  async auditDelivery(args: {
    identity: Identity;
    projectId: string;
    sessionId: string;
    allocationId?: string;
    delivered: ReadonlyArray<{
      kind: string;
      name: string;
      fingerprint: string;
    }>;
    refused: readonly string[];
  }): Promise<void> {
    await this.audit({
      identity: args.identity,
      projectId: args.projectId,
      ...(args.allocationId ? { allocationId: args.allocationId } : {}),
      eventType: "personal_environment.deliver",
      metadata: {
        sessionId: args.sessionId,
        delivered: args.delivered.map(({ kind, name, fingerprint }) => ({
          kind,
          name,
          fingerprint,
        })),
        refused: [...args.refused],
      },
    });
  }

  private async allowed(identity: Identity, projectId: string) {
    const policy = await this.deps.environments.list({ identity, projectId });
    return Object.entries(policy.environments).some(
      ([name, definition]) =>
        definition.personalCredentials === true &&
        identityMayUseEnvironment(identity, projectId, name),
    );
  }

  private async audit(args: {
    identity: Identity;
    projectId: string;
    allocationId?: string;
    eventType: string;
    metadata: Json;
  }): Promise<void> {
    await this.deps.db
      .insertInto("connection_audit_events")
      .values({
        tenant_id: args.identity.tenantId,
        project_id: args.projectId,
        allocation_id: args.allocationId ?? null,
        actor_external_user_id: args.identity.externalUserId,
        event_type: args.eventType,
        outcome: "allowed",
        metadata: toJson(args.metadata),
      })
      .execute();
  }
}
