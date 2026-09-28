import { createHash } from "node:crypto";
import type { DB, Json } from "@catamorphic/db";
import {
  PERSONAL_LOGIN_KINDS,
  type PersonalLoginKind,
} from "@catamorphic/sandbox";
import type { Kysely } from "kysely";
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
 * A member's personal environment for one project (ADR 0184): their own
 * Claude Code and Codex logins (refresh tokens stripped by their desktop)
 * and the files they listed in `.work/personal/environment.json`. Values
 * are sealed in the credential vault; rows hold references, fingerprints,
 * and sizes. Only the member reads or replaces their own set, and no API
 * returns a value: core unseals it only to deliver it into that member's
 * own chats' sandboxes.
 */

/** At most this many personal files per member and project. */
export const PERSONAL_FILES_MAX = 50;
/** The largest personal file. */
export const PERSONAL_FILE_MAX_BYTES = 256 * 1024;
/** The largest login document. */
export const PERSONAL_LOGIN_MAX_BYTES = 64 * 1024;
/** A login expiring sooner than this asks its desktop for a fresh copy. */
export const PERSONAL_LOGIN_REFRESH_WINDOW_MS = 60 * 60_000;

/** What a member's desktop sends: logins and files, replacing the set. */
export interface PersonalEnvironmentInput {
  logins: {
    /** Claude Code's `.credentials.json`, as JSON text. */
    "claude-code"?: { credentials: string; expiresAt?: string };
    /** Codex's `auth.json`, as JSON text. */
    codex?: { auth: string; expiresAt?: string };
  };
  /** Repository-relative files; `content` is base64. */
  files: ReadonlyArray<{ path: string; content: string }>;
}

export interface PersonalLoginStatus {
  fingerprint: string;
  expiresAt?: string;
  updatedAt: string;
  /**
   * The login expires within the hour while this member has live chats
   * that use it: their desktop should refresh it and send it again.
   */
  needsRefresh: boolean;
}

export interface PersonalFileStatus {
  path: string;
  fingerprint: string;
  bytes: number;
  updatedAt: string;
}

/** What the server holds for the caller. Never a value. */
export interface PersonalEnvironmentStatus {
  /** Some Environment of the project gives this member's chats their credentials. */
  allowed: boolean;
  logins: Partial<Record<PersonalLoginKind, PersonalLoginStatus>>;
  files: PersonalFileStatus[];
}

/** One login or file, unsealed for delivery into a sandbox. */
export interface UnsealedPersonalEnvironment {
  logins: Map<
    PersonalLoginKind,
    { content: string; fingerprint: string; expiresAt: Date | null }
  >;
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

/** Whether a login document still holds a refresh token anywhere. */
export function holdsRefreshToken(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(holdsRefreshToken);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, child]) =>
      (/^refresh[_-]?token$/i.test(key) &&
        typeof child === "string" &&
        child.length > 0) ||
      holdsRefreshToken(child),
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

/** When a JWT's `exp` says it expires, if it says. */
function jwtExpiry(token: unknown): Date | undefined {
  if (typeof token !== "string") return undefined;
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const exp = record(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    )?.exp;
    return typeof exp === "number" ? new Date(exp * 1000) : undefined;
  } catch {
    return undefined;
  }
}

function parseInstant(value: string | undefined): Date | undefined | null {
  if (value === undefined) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `sha256:<hex>` of the bytes: names content without revealing it. */
export function personalFingerprint(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

const HARNESS_NAMES: Record<PersonalLoginKind, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

interface ValidEntry {
  kind: "login" | "file";
  name: string;
  content: Buffer;
  expiresAt: Date | null;
}

/** Check a desktop's set and turn it into entries, or refuse it whole. */
export function validatePersonalEnvironment(
  input: PersonalEnvironmentInput,
): ValidEntry[] {
  const issues: string[] = [];
  const entries: ValidEntry[] = [];
  for (const kind of PERSONAL_LOGIN_KINDS) {
    const login = input.logins[kind];
    if (!login) continue;
    const name = HARNESS_NAMES[kind];
    const text = "credentials" in login ? login.credentials : login.auth;
    if (Buffer.byteLength(text) > PERSONAL_LOGIN_MAX_BYTES) {
      issues.push(`The ${name} login is larger than 64 KiB`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      issues.push(`The ${name} login is not JSON`);
      continue;
    }
    const document = record(parsed);
    if (!document) {
      issues.push(`The ${name} login is not a JSON object`);
      continue;
    }
    if (holdsRefreshToken(document)) {
      issues.push(
        `The ${name} login still holds a refresh token; remove it before sending, so only your computer ever renews your login`,
      );
      continue;
    }
    const given = parseInstant(login.expiresAt);
    if (given === null) {
      issues.push(`The ${name} login's expiresAt is not a date`);
      continue;
    }
    let expiresAt = given;
    if (kind === "claude-code") {
      const oauth = record(document.claudeAiOauth);
      if (!oauth || typeof oauth.accessToken !== "string") {
        issues.push(
          "The Claude Code login has no claudeAiOauth.accessToken; sign in to Claude Code on your computer",
        );
        continue;
      }
      if (!expiresAt && typeof oauth.expiresAt === "number")
        expiresAt = new Date(oauth.expiresAt);
    } else {
      const tokens = record(document.tokens);
      if (
        typeof tokens?.access_token !== "string" &&
        typeof document.OPENAI_API_KEY !== "string"
      ) {
        issues.push(
          "The Codex login has no tokens.access_token; sign in to Codex on your computer",
        );
        continue;
      }
      expiresAt ??= jwtExpiry(tokens?.access_token);
    }
    entries.push({
      kind: "login",
      name: kind,
      content: Buffer.from(text, "utf8"),
      expiresAt: expiresAt ?? null,
    });
  }
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
    entries.push({ kind: "file", name: file.path, content, expiresAt: null });
  }
  if (issues.length > 0) throw new PersonalEnvironmentInvalidError(issues);
  return entries;
}

export class PersonalEnvironmentService {
  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      vault?: CredentialVault;
      environments: ProjectEnvironmentsService;
      /**
       * The logins this member's live chats in the project run with, so a
       * soon-expiring one is flagged for refresh.
       */
      loginsInUse?: (args: {
        identity: Identity;
        projectId: string;
      }) => Promise<ReadonlySet<PersonalLoginKind>>;
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
    const current = await this.deps.db
      .selectFrom("personal_environment_entries")
      .selectAll()
      .where("tenant_id", "=", owner.tenant_id)
      .where("project_id", "=", projectId)
      .where("external_user_id", "=", owner.external_user_id)
      .execute();
    const key = (entry: { kind: string; name: string }) =>
      `${entry.kind}\u0000${entry.name}`;
    const existing = new Map(current.map((row) => [key(row), row]));
    const released: string[] = [];
    const changed: Array<{ kind: string; name: string; fingerprint: string }> =
      [];
    for (const entry of entries) {
      const fingerprint = personalFingerprint(entry.content);
      const previous = existing.get(key(entry));
      if (
        previous?.fingerprint === fingerprint &&
        (previous.expires_at?.getTime() ?? null) ===
          (entry.expiresAt?.getTime() ?? null)
      )
        continue;
      const sealed = await vault.put({
        tenantId: identity.tenantId,
        material: entry.content,
      });
      await this.deps.db
        .insertInto("personal_environment_entries")
        .values({
          ...owner,
          kind: entry.kind,
          name: entry.name,
          credential_ref: sealed.id,
          fingerprint,
          bytes: entry.content.byteLength,
          expires_at: entry.expiresAt,
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
              credential_ref: sealed.id,
              fingerprint,
              bytes: entry.content.byteLength,
              expires_at: entry.expiresAt,
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
      await this.deps.db
        .deleteFrom("personal_environment_entries")
        .where("tenant_id", "=", row.tenant_id)
        .where("project_id", "=", row.project_id)
        .where("external_user_id", "=", row.external_user_id)
        .where("kind", "=", row.kind)
        .where("name", "=", row.name)
        .where("credential_ref", "=", row.credential_ref)
        .execute();
      released.push(row.credential_ref);
    }
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
          removed: removed.map((row) => ({ kind: row.kind, name: row.name })),
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
      .select([
        "kind",
        "name",
        "fingerprint",
        "bytes",
        "expires_at",
        "updated_at",
      ])
      .where("tenant_id", "=", identity.tenantId)
      .where("project_id", "=", projectId)
      .where("external_user_id", "=", identity.externalUserId)
      .orderBy("kind")
      .orderBy("name")
      .execute();
    const inUse = rows.some((row) => row.kind === "login")
      ? ((await this.deps.loginsInUse?.({ identity, projectId })) ?? new Set())
      : new Set<PersonalLoginKind>();
    const now = Date.now();
    const logins: Partial<Record<PersonalLoginKind, PersonalLoginStatus>> = {};
    for (const row of rows) {
      if (row.kind !== "login") continue;
      const kind = PERSONAL_LOGIN_KINDS.find((name) => name === row.name);
      if (!kind) continue;
      logins[kind] = {
        fingerprint: row.fingerprint,
        ...(row.expires_at ? { expiresAt: row.expires_at.toISOString() } : {}),
        updatedAt: row.updated_at.toISOString(),
        needsRefresh:
          inUse.has(kind) &&
          row.expires_at !== null &&
          row.expires_at.getTime() - now < PERSONAL_LOGIN_REFRESH_WINDOW_MS,
      };
    }
    return {
      allowed: await this.allowed(identity, projectId),
      logins,
      files: rows
        .filter((row) => row.kind === "file")
        .map((row) => ({
          path: row.name,
          fingerprint: row.fingerprint,
          bytes: row.bytes,
          updatedAt: row.updated_at.toISOString(),
        })),
    };
  }

  /** Forget everything the caller sent for the project. */
  async remove(args: { identity: Identity; projectId: string }): Promise<void> {
    const { identity, projectId } = args;
    await this.requireMember(identity, projectId);
    const rows = await this.deps.db
      .deleteFrom("personal_environment_entries")
      .where("tenant_id", "=", identity.tenantId)
      .where("project_id", "=", projectId)
      .where("external_user_id", "=", identity.externalUserId)
      .returning(["kind", "name", "credential_ref"])
      .execute();
    for (const row of rows)
      await this.deps.vault
        ?.delete({
          tenantId: identity.tenantId,
          ref: { id: row.credential_ref },
        })
        .catch(() => {});
    if (rows.length > 0)
      await this.audit({
        identity,
        projectId,
        eventType: "personal_environment.remove",
        metadata: {
          removed: rows.map((row) => ({ kind: row.kind, name: row.name })),
        },
      });
  }

  /** Whether the member has sent anything for the project. Host-only. */
  async holds(args: {
    tenantId: string;
    projectId: string;
    owner: string;
  }): Promise<boolean> {
    const row = await this.deps.db
      .selectFrom("personal_environment_entries")
      .select("kind")
      .where("tenant_id", "=", args.tenantId)
      .where("project_id", "=", args.projectId)
      .where("external_user_id", "=", args.owner)
      .limit(1)
      .executeTakeFirst();
    return Boolean(row);
  }

  /** Whether the member sent this harness login for the project. Host-only. */
  async holdsLogin(args: {
    tenantId: string;
    projectId: string;
    owner: string;
    kind: PersonalLoginKind;
  }): Promise<boolean> {
    const row = await this.deps.db
      .selectFrom("personal_environment_entries")
      .select("name")
      .where("tenant_id", "=", args.tenantId)
      .where("project_id", "=", args.projectId)
      .where("external_user_id", "=", args.owner)
      .where("kind", "=", "login")
      .where("name", "=", args.kind)
      .executeTakeFirst();
    return Boolean(row);
  }

  /**
   * The owner's logins (only those named) and files, unsealed for delivery
   * into one of their own chats' sandboxes. Host-only: never an API.
   */
  async unseal(args: {
    tenantId: string;
    projectId: string;
    owner: string;
    logins: readonly PersonalLoginKind[];
  }): Promise<UnsealedPersonalEnvironment> {
    const result: UnsealedPersonalEnvironment = {
      logins: new Map(),
      files: [],
    };
    const vault = this.deps.vault;
    if (!vault) return result;
    const rows = await this.deps.db
      .selectFrom("personal_environment_entries")
      .selectAll()
      .where("tenant_id", "=", args.tenantId)
      .where("project_id", "=", args.projectId)
      .where("external_user_id", "=", args.owner)
      .orderBy("name")
      .execute();
    for (const row of rows) {
      const kind =
        row.kind === "login"
          ? args.logins.find((name) => name === row.name)
          : undefined;
      if (row.kind === "login" && !kind) continue;
      const content = await vault.withMaterial({
        tenantId: args.tenantId,
        ref: { id: row.credential_ref },
        use: (material) => Buffer.from(material),
      });
      if (kind)
        result.logins.set(kind, {
          content: content.toString("utf8"),
          fingerprint: row.fingerprint,
          expiresAt: row.expires_at,
        });
      else
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
