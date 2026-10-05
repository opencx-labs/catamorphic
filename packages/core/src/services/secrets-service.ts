import { createHash } from "node:crypto";
import type { DB, Json } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import { type Kysely, sql, type Transaction } from "kysely";
import {
  hasProjectPermission,
  type Identity,
  isProjectPrincipal,
  mayUseProject,
} from "../identity.js";
import {
  AccessDeniedError,
  assertProjectPermission,
} from "./artifact-scope.js";
import type { CredentialVault } from "./credential-vault.js";
import {
  type PluginsService,
  UndeclaredSecretError,
} from "./plugins-service.js";
import type { ProjectEnvironmentsService } from "./project-environments-service.js";
import { requireTenantProject } from "./projects-service.js";
import { toJson } from "./run-coordinator.js";

const tracer = getTracer("@catamorphic/core");

/** One stored value's metadata: never the value. */
export interface SecretMemberValue {
  /** The member's external user id. */
  member: string;
  updatedAt: string;
  /** Who stored it: the member, someone onboarding them, or a run's caller. */
  setBy: string | null;
}

/**
 * One declared secret as management APIs report it (ADR 0205): where it is
 * declared, which Environments receive it, and which values exist. Never a
 * value.
 */
export interface SecretStatus {
  name: string;
  label?: string;
  description?: string;
  required: boolean;
  /** Where the declaration came from, for UI grouping. */
  source: "project" | "plugin";
  /** Environments whose sandboxes receive it. */
  environments: string[];
  /** A shared value is set. */
  shared: boolean;
  /** When the shared value was stored, and by whom. */
  updatedAt: string | null;
  setBy: string | null;
  /** The caller holds a value of their own. */
  own: boolean;
  ownUpdatedAt: string | null;
  /** Members holding their own value; empty without `secrets:read`. */
  members: SecretMemberValue[];
}

/** What changed when a value was stored or removed. */
export interface SecretValueChange {
  name: string;
  /** The member whose value it is, or null for the shared value. */
  member: string | null;
  updatedAt: string;
}

/**
 * Why a name an Environment lists reaches its sandboxes without a value
 * (ADR 0205): no value for this person and no default, no declaration, a
 * webhook signing secret (control plane only), or a variable Work and the
 * sandbox's shells depend on.
 */
export type SandboxSecretGap = "unset" | "undeclared" | "webhook" | "reserved";

/** An Environment's secrets resolved for one owner's sandbox. */
export interface SandboxSecrets {
  variables: Record<string, string>;
  /** What was resolved and from where, by fingerprint, for the audit. */
  delivered: Array<{
    name: string;
    source: "member" | "shared" | "default";
    fingerprint: string;
  }>;
  missing: Array<{ name: string; reason: SandboxSecretGap }>;
}

interface DeclaredSecretEntry {
  label?: string;
  description?: string;
  required: boolean;
  default?: string;
  /**
   * `run`: reaches workflow runs and Environments. `webhook`: verifies
   * deliveries on the control plane only. `environment`: declared in
   * `project.json` for Environments only (ADR 0205).
   */
  use: "run" | "webhook" | "environment";
  source: "project" | "plugin";
  /** A plugin also declares this project webhook secret's name. */
  conflict?: true;
}

/**
 * Variables a secret may not set in a sandbox: its shells, the agent
 * runner and the egress proxy (ADR 0203) depend on them.
 * Replica memory (c): a constant, the same on every replica.
 */
const RESERVED_SANDBOX_VARIABLES: ReadonlySet<string> = new Set([
  "BASH_ENV",
  "ENV",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "IFS",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "LOGNAME",
  "NODE_USE_ENV_PROXY",
  "NO_PROXY",
  "OLDPWD",
  "PATH",
  "PWD",
  "SHELL",
  "USER",
]);

/** The largest value a secret may hold. */
export const SECRET_VALUE_MAX_BYTES = 64 * 1024;

/**
 * A plugin declares a secret the project declares webhook-only: the plugin
 * would receive the webhook signing key in every run, so neither gets a
 * value until one of them is renamed.
 */
export class SecretDeclarationConflictError extends Error {
  constructor(readonly secretNames: readonly string[]) {
    super(
      `Secret ${secretNames.map((name) => `'${name}'`).join(", ")} is declared webhook-only by the project and also by an attached plugin; rename one of them`,
    );
    this.name = "SecretDeclarationConflictError";
  }
}

/** A value a secret cannot hold: too large, or not an environment value. */
export class SecretValueInvalidError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SecretValueInvalidError";
  }
}

/** A member's value was asked for someone who is not a member. */
export class SecretMemberNotFoundError extends Error {
  constructor(readonly member: string) {
    super(`${member} is not a member of this project`);
    this.name = "SecretMemberNotFoundError";
  }
}

/**
 * Resolves the secrets a project declares in its own code via `defineSecrets`.
 * Supplied by the host so this service stays free of git and parser concerns.
 */
export type ProjectSecretDeclarationsReader = (args: {
  identity: Identity;
  projectId: string;
  /** `run`: injecting into a run the caller may start, not managing values. */
  purpose: "manage" | "run";
}) => Promise<
  readonly {
    name: string;
    label?: string;
    description?: string;
    required: boolean;
    default?: string;
    use?: "run" | "webhook";
  }[]
>;

/** `sha256:<hex>` of a value: names it in the audit without revealing it. */
export function secretFingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function checkValue(value: string): void {
  if (Buffer.byteLength(value) > SECRET_VALUE_MAX_BYTES)
    throw new SecretValueInvalidError(
      `A secret's value may be at most ${SECRET_VALUE_MAX_BYTES / 1024} KiB`,
    );
  if (value.includes("\0"))
    throw new SecretValueInvalidError(
      "A secret's value may not contain a NUL character",
    );
}

type ValueRow = {
  name: string;
  member_external_user_id: string | null;
  value: string | null;
  credential_ref: string | null;
};

/**
 * Per-project secret store (ADR 0205). A secret declared by `defineSecrets`,
 * a plugin, or `project.json` may hold a shared value and one value per
 * member. Values are only read back through {@link loadForRun},
 * {@link value} and {@link resolveForSandbox}; management APIs expose
 * presence metadata, never a value. With a credential vault (ADR 0162) a
 * row holds only a vault reference, so database access alone reveals no
 * secret; rows written before sealing are sealed on first read.
 *
 * Code declarations win over `project.json`, since the code reads the value
 * and states how; plugin declarations win over both, except over a project
 * webhook secret: that name stays webhook-only and is refused a value and a
 * run until the clash is resolved.
 */
export class SecretsService {
  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      plugins?: Pick<PluginsService, "getDeclaredSecrets">;
      projectDeclarations?: ProjectSecretDeclarationsReader;
      vault?: CredentialVault;
      /** `project.json`: its `secrets` and each Environment's list. */
      environments?: Pick<ProjectEnvironmentsService, "list">;
      /**
       * Whether someone is a member of the project, so a value is never
       * kept for anyone else. Without it, any id is accepted.
       */
      isMember?: (args: {
        tenantId: string;
        projectId: string;
        externalUserId: string;
      }) => Promise<boolean>;
    },
  ) {}

  private get db(): Kysely<DB> {
    return this.deps.db;
  }

  /**
   * The shared value, unsealed for immediate use. Used by run injection and
   * webhook verification; never exposed through management APIs.
   */
  async value(opts: {
    tenantId: string;
    projectId: string;
    name: string;
  }): Promise<string | undefined> {
    const row = await this.db
      .selectFrom("project_secrets")
      .where("project_id", "=", opts.projectId)
      .where("name", "=", opts.name)
      .where("member_external_user_id", "is", null)
      .select(["name", "member_external_user_id", "value", "credential_ref"])
      .executeTakeFirst();
    return row ? this.unseal({ ...opts, row }) : undefined;
  }

  private async unseal(args: {
    tenantId: string;
    projectId: string;
    row: ValueRow;
  }): Promise<string> {
    const { row } = args;
    if (row.credential_ref) {
      if (!this.deps.vault) throw new Error("Secret vault is not configured");
      return this.deps.vault.withMaterial({
        tenantId: args.tenantId,
        ref: { id: row.credential_ref },
        use: (material) => new TextDecoder().decode(material),
      });
    }
    const value = row.value ?? "";
    const vault = this.deps.vault;
    if (vault) {
      // Seal in place only if the row still holds this plain value: a newer
      // write that landed meanwhile wins, and our sealed copy is dropped.
      const sealed = await vault.put({
        tenantId: args.tenantId,
        material: new TextEncoder().encode(value),
      });
      const updated = await this.db
        .updateTable("project_secrets")
        .set({ value: null, credential_ref: sealed.id })
        .where("project_id", "=", args.projectId)
        .where("name", "=", row.name)
        .where((eb) =>
          row.member_external_user_id === null
            ? eb("member_external_user_id", "is", null)
            : eb("member_external_user_id", "=", row.member_external_user_id),
        )
        .where("credential_ref", "is", null)
        .where("value", "=", value)
        .returning("name")
        .executeTakeFirst();
      if (!updated)
        await vault.delete({ tenantId: args.tenantId, ref: sealed });
    }
    return value;
  }

  /**
   * Write one value, sealed when a vault exists, and drop the record it
   * replaced. Writers of one value take turns, so each releases exactly
   * the record it displaced.
   */
  private async store(args: {
    tenantId: string;
    projectId: string;
    name: string;
    member: string | null;
    value: string;
    setBy: string;
    updatedAt: Date;
  }): Promise<void> {
    const vault = this.deps.vault;
    const sealed = vault
      ? await vault.put({
          tenantId: args.tenantId,
          material: new TextEncoder().encode(args.value),
        })
      : undefined;
    const columns = sealed
      ? { value: null, credential_ref: sealed.id }
      : { value: args.value, credential_ref: null };
    let previous: string | null | undefined;
    try {
      previous = await this.db.transaction().execute(async (trx) => {
        await lockValue({ trx, ...args });
        const current = await trx
          .selectFrom("project_secrets")
          .where("project_id", "=", args.projectId)
          .where("name", "=", args.name)
          .where((eb) =>
            args.member === null
              ? eb("member_external_user_id", "is", null)
              : eb("member_external_user_id", "=", args.member),
          )
          .select("credential_ref")
          .executeTakeFirst();
        await trx
          .insertInto("project_secrets")
          .values({
            project_id: args.projectId,
            name: args.name,
            member_external_user_id: args.member,
            set_by: args.setBy,
            updated_at: args.updatedAt,
            ...columns,
          })
          .onConflict((oc) =>
            oc.constraint("project_secrets_value_key").doUpdateSet({
              ...columns,
              set_by: args.setBy,
              updated_at: args.updatedAt,
            }),
          )
          .execute();
        return current?.credential_ref;
      });
    } catch (error) {
      if (sealed && vault)
        await vault
          .delete({ tenantId: args.tenantId, ref: sealed })
          .catch(() => {});
      throw error;
    }
    if (previous && vault)
      await vault
        .delete({ tenantId: args.tenantId, ref: { id: previous } })
        .catch(() => {});
  }

  /** Remove one value and its vault record; whether one existed. */
  private async remove(args: {
    tenantId: string;
    projectId: string;
    name: string;
    member: string | null;
  }): Promise<boolean> {
    const removed = await this.db.transaction().execute(async (trx) => {
      await lockValue({ trx, ...args });
      return trx
        .deleteFrom("project_secrets")
        .where("project_id", "=", args.projectId)
        .where("name", "=", args.name)
        .where((eb) =>
          args.member === null
            ? eb("member_external_user_id", "is", null)
            : eb("member_external_user_id", "=", args.member),
        )
        .returning("credential_ref")
        .executeTakeFirst();
    });
    if (removed?.credential_ref && this.deps.vault)
      await this.deps.vault
        .delete({
          tenantId: args.tenantId,
          ref: { id: removed.credential_ref },
        })
        .catch(() => {});
    return removed !== undefined;
  }

  private async declaredSecrets(args: {
    identity: Identity;
    projectId: string;
    purpose?: "manage" | "run";
    /** `project.json`'s declarations, when already read. */
    manifest?: Readonly<
      Record<string, { label?: string; description?: string }>
    >;
  }): Promise<Map<string, DeclaredSecretEntry>> {
    const { identity, projectId } = args;
    const declared = new Map<string, DeclaredSecretEntry>();

    for (const secret of (await this.deps.projectDeclarations?.({
      identity,
      projectId,
      purpose: args.purpose ?? "manage",
    })) ?? []) {
      declared.set(secret.name, {
        label: secret.label,
        description: secret.description,
        required: secret.required,
        default: secret.default,
        use: secret.use ?? "run",
        source: "project",
      });
    }

    // Secrets only Environments use belong in `project.json` (ADR 0205).
    const manifest =
      args.manifest ??
      (await this.manifest({ identity, projectId })).declarations;
    for (const [name, secret] of Object.entries(manifest)) {
      if (declared.has(name)) continue;
      declared.set(name, {
        ...(secret.label ? { label: secret.label } : {}),
        ...(secret.description ? { description: secret.description } : {}),
        required: false,
        use: "environment",
        source: "project",
      });
    }

    for (const [name, secret] of (await this.deps.plugins?.getDeclaredSecrets(
      projectId,
    )) ?? new Map()) {
      const project = declared.get(name);
      if (project?.use === "webhook") {
        declared.set(name, { ...project, conflict: true });
        continue;
      }
      declared.set(name, {
        label: secret.label,
        description: secret.description,
        required: secret.required,
        default: secret.default,
        use: "run",
        source: "plugin",
      });
    }

    return declared;
  }

  /** `project.json`: declared secrets and the Environments listing each. */
  private async manifest(args: {
    identity: Identity;
    projectId: string;
  }): Promise<{
    declarations: Readonly<
      Record<string, { label?: string; description?: string }>
    >;
    environments: Readonly<Record<string, readonly string[]>>;
  }> {
    const policy = await this.deps.environments?.list(args);
    return {
      declarations: policy?.secrets ?? {},
      environments: Object.fromEntries(
        Object.entries(policy?.environments ?? {}).map(([name, definition]) => [
          name,
          definition.secrets ?? [],
        ]),
      ),
    };
  }

  /**
   * The project's secrets as the caller may see them. Holders of
   * `secrets:read` see every declared secret and who holds a value of
   * their own; any other member sees the secrets a run or an Environment
   * uses, whether a shared value exists, and their own.
   */
  async list(opts: {
    identity: Identity;
    projectId: string;
  }): Promise<SecretStatus[]> {
    const { identity, projectId } = opts;
    const reader = hasProjectPermission(identity, projectId, "secrets:read");
    if (!reader) requireMember(identity, projectId);
    await requireTenantProject(this.db, identity.tenantId, projectId);
    const manifest = await this.manifest({ identity, projectId });
    const all = await this.declaredSecrets({
      identity,
      projectId,
      purpose: reader ? "manage" : "run",
      manifest: manifest.declarations,
    });
    const declared = [...all].filter(
      ([, entry]) => reader || entry.use !== "webhook",
    );
    if (declared.length === 0) return [];

    const caller = isProjectPrincipal(identity.externalUserId)
      ? null
      : identity.externalUserId;
    const rows = await this.db
      .selectFrom("project_secrets")
      .where("project_id", "=", projectId)
      .where(
        "name",
        "in",
        declared.map(([name]) => name),
      )
      .$if(!reader, (query) =>
        query.where((eb) =>
          eb.or([
            eb("member_external_user_id", "is", null),
            ...(caller ? [eb("member_external_user_id", "=", caller)] : []),
          ]),
        ),
      )
      .select(["name", "member_external_user_id", "updated_at", "set_by"])
      .execute();

    return declared.map(([name, entry]) => {
      const values = rows.filter((row) => row.name === name);
      const shared = values.find((row) => row.member_external_user_id === null);
      const own = caller
        ? values.find((row) => row.member_external_user_id === caller)
        : undefined;
      return {
        name,
        ...(entry.label ? { label: entry.label } : {}),
        ...(entry.description ? { description: entry.description } : {}),
        required: entry.required,
        source: entry.source,
        environments: Object.entries(manifest.environments)
          .filter(([, names]) => names.includes(name))
          .map(([environment]) => environment)
          .sort(),
        shared: shared !== undefined,
        updatedAt: shared?.updated_at.toISOString() ?? null,
        setBy: shared?.set_by ?? null,
        own: own !== undefined,
        ownUpdatedAt: own?.updated_at.toISOString() ?? null,
        members: reader
          ? values
              .flatMap((row) =>
                row.member_external_user_id === null
                  ? []
                  : [
                      {
                        member: row.member_external_user_id,
                        updatedAt: row.updated_at.toISOString(),
                        setBy: row.set_by,
                      },
                    ],
              )
              .sort((left, right) =>
                left.member < right.member
                  ? -1
                  : left.member > right.member
                    ? 1
                    : 0,
              )
          : [],
      };
    });
  }

  /** The secret a write names, declared and able to hold a value. */
  private async writable(args: {
    identity: Identity;
    projectId: string;
    name: string;
    purpose: "manage" | "run";
  }): Promise<DeclaredSecretEntry> {
    const declared = await this.declaredSecrets(args);
    const entry = declared.get(args.name);
    if (!entry) throw new UndeclaredSecretError(args.name);
    if (entry.conflict) throw new SecretDeclarationConflictError([args.name]);
    return entry;
  }

  /** Set or replace the shared value. Needs `secrets:write`. */
  async upsert(opts: {
    identity: Identity;
    projectId: string;
    name: string;
    value: string;
  }): Promise<SecretStatus> {
    const { identity, projectId, name, value } = opts;
    assertProjectPermission(identity, projectId, "secrets:write");
    checkValue(value);
    await requireTenantProject(this.db, identity.tenantId, projectId);
    await this.writable({ identity, projectId, name, purpose: "manage" });
    await this.store({
      tenantId: identity.tenantId,
      projectId,
      name,
      member: null,
      value,
      setBy: identity.externalUserId,
      updatedAt: new Date(),
    });
    await this.audit({
      identity,
      projectId,
      eventType: "project_secrets.set",
      metadata: { name, member: null },
    });
    const status = (await this.list({ identity, projectId })).find(
      (entry) => entry.name === name,
    );
    if (!status) throw new UndeclaredSecretError(name);
    return status;
  }

  /** Remove the shared value. Needs `secrets:write`. */
  async delete(opts: {
    identity: Identity;
    projectId: string;
    name: string;
  }): Promise<boolean> {
    const { identity, projectId, name } = opts;
    assertProjectPermission(identity, projectId, "secrets:write");
    await requireTenantProject(this.db, identity.tenantId, projectId);
    const removed = await this.remove({
      tenantId: identity.tenantId,
      projectId,
      name,
      member: null,
    });
    if (removed)
      await this.audit({
        identity,
        projectId,
        eventType: "project_secrets.delete",
        metadata: { name, member: null },
      });
    return removed;
  }

  /**
   * Who may set or remove `member`'s own value: the member, for their own
   * value; anyone holding `secrets:write`, for any member's.
   */
  private async authorizeMember(args: {
    identity: Identity;
    projectId: string;
    member: string;
  }): Promise<"self" | "manager"> {
    const { identity, projectId, member } = args;
    if (isProjectPrincipal(member))
      throw new SecretValueInvalidError(
        "The project's own chats use the shared value; set that instead",
      );
    if (member === identity.externalUserId) {
      requireMember(identity, projectId);
      return "self";
    }
    assertProjectPermission(identity, projectId, "secrets:write");
    return "manager";
  }

  /**
   * Set or replace one member's own value (ADR 0205): the member's own
   * chats receive it instead of the shared value.
   */
  async setMember(opts: {
    identity: Identity;
    projectId: string;
    name: string;
    member: string;
    value: string;
  }): Promise<SecretValueChange> {
    const { identity, projectId, name, member, value } = opts;
    const role = await this.authorizeMember({ identity, projectId, member });
    checkValue(value);
    await requireTenantProject(this.db, identity.tenantId, projectId);
    if (
      role === "manager" &&
      this.deps.isMember &&
      !(await this.deps.isMember({
        tenantId: identity.tenantId,
        projectId,
        externalUserId: member,
      }))
    )
      throw new SecretMemberNotFoundError(member);
    const entry = await this.writable({
      identity,
      projectId,
      name,
      purpose: role === "manager" ? "manage" : "run",
    });
    if (entry.use === "webhook")
      throw new SecretValueInvalidError(
        `'${name}' verifies webhook deliveries and holds only a shared value`,
      );
    const updatedAt = new Date();
    await this.store({
      tenantId: identity.tenantId,
      projectId,
      name,
      member,
      value,
      setBy: identity.externalUserId,
      updatedAt,
    });
    await this.audit({
      identity,
      projectId,
      eventType: "project_secrets.set",
      metadata: { name, member },
    });
    return { name, member, updatedAt: updatedAt.toISOString() };
  }

  /** Remove one member's own value; whether one existed. */
  async deleteMember(opts: {
    identity: Identity;
    projectId: string;
    name: string;
    member: string;
  }): Promise<boolean> {
    const { identity, projectId, name, member } = opts;
    await this.authorizeMember({ identity, projectId, member });
    await requireTenantProject(this.db, identity.tenantId, projectId);
    const removed = await this.remove({
      tenantId: identity.tenantId,
      projectId,
      name,
      member,
    });
    if (removed)
      await this.audit({
        identity,
        projectId,
        eventType: "project_secrets.delete",
        metadata: { name, member },
      });
    return removed;
  }

  /**
   * Materialize secret name/value pairs for run-time injection: shared
   * values only. Applies the declared `default` when no value is set.
   * Required secrets with no value + no default are returned as missing so
   * the caller can surface a clear error.
   */
  async loadForRun(opts: { identity: Identity; projectId: string }): Promise<{
    values: Record<string, string>;
    missingRequired: string[];
  }> {
    const { identity, projectId } = opts;
    const all = await this.declaredSecrets({
      identity,
      projectId,
      purpose: "run",
    });
    const conflicts = [...all]
      .filter(([, secret]) => secret.conflict)
      .map(([name]) => name);
    if (conflicts.length > 0)
      throw new SecretDeclarationConflictError(conflicts);
    // Webhook signing secrets are checked on the control plane and never
    // reach a run; `project.json` declarations are for Environments.
    const declared = new Map(
      [...all].filter(([, secret]) => secret.use === "run"),
    );
    if (declared.size === 0) {
      return { values: {}, missingRequired: [] };
    }

    const stored = await this.storedValues({
      tenantId: identity.tenantId,
      projectId,
      names: [...declared.keys()],
      owner: null,
    });
    const values: Record<string, string> = {};
    const missingRequired: string[] = [];

    for (const [name, secret] of declared) {
      const value = stored.get(name)?.shared;
      if (value !== undefined) {
        values[name] = value;
        continue;
      }
      if (secret.default !== undefined) {
        values[name] = secret.default;
        continue;
      }
      if (secret.required) missingRequired.push(name);
    }

    return { values, missingRequired };
  }

  /** Values of `names`: shared, and `owner`'s own when an owner is given. */
  private async storedValues(args: {
    tenantId: string;
    projectId: string;
    names: readonly string[];
    owner: string | null;
  }): Promise<Map<string, { shared?: string; own?: string }>> {
    const result = new Map<string, { shared?: string; own?: string }>();
    if (args.names.length === 0) return result;
    const { owner } = args;
    const rows = await this.db
      .selectFrom("project_secrets")
      .where("project_id", "=", args.projectId)
      .where("name", "in", [...args.names])
      .where((eb) =>
        eb.or([
          eb("member_external_user_id", "is", null),
          ...(owner ? [eb("member_external_user_id", "=", owner)] : []),
        ]),
      )
      .select(["name", "member_external_user_id", "value", "credential_ref"])
      .execute();
    for (const row of rows) {
      const value = await this.unseal({
        tenantId: args.tenantId,
        projectId: args.projectId,
        row,
      });
      const entry = result.get(row.name) ?? {};
      if (row.member_external_user_id === null) entry.shared = value;
      else entry.own = value;
      result.set(row.name, entry);
    }
    return result;
  }

  /** The names an Environment lists in `project.json` (ADR 0205). */
  async environmentSecrets(opts: {
    identity: Identity;
    projectId: string;
    environment: string;
  }): Promise<readonly string[]> {
    const manifest = await this.manifest(opts);
    return manifest.environments[opts.environment] ?? [];
  }

  /**
   * An Environment's secrets for one sandbox (ADR 0205): for a member's
   * own work their value, else the shared one, else the declared default;
   * for the project's own work (`owner` null) the shared value or the
   * default. Host-only: callers decide whether the placement may hold them.
   */
  async resolveForSandbox(opts: {
    identity: Identity;
    projectId: string;
    environment: string;
    owner: string | null;
  }): Promise<SandboxSecrets> {
    return withSpan(
      {
        tracer,
        name: "secrets.resolve_for_sandbox",
        attributes: {
          "catamorphic.tenant.id": opts.identity.tenantId,
          "catamorphic.project.id": opts.projectId,
          "catamorphic.environment.name": opts.environment,
        },
      },
      async (span) => {
        const result: SandboxSecrets = {
          variables: {},
          delivered: [],
          missing: [],
        };
        const { identity, projectId, owner } = opts;
        const manifest = await this.manifest({ identity, projectId });
        const names = manifest.environments[opts.environment] ?? [];
        if (names.length === 0) return result;
        const declared = await this.declaredSecrets({
          identity,
          projectId,
          purpose: "run",
          manifest: manifest.declarations,
        });
        const deliverable: string[] = [];
        for (const name of names) {
          const entry = declared.get(name);
          const reason: SandboxSecretGap | undefined = !entry
            ? "undeclared"
            : entry.use === "webhook" || entry.conflict
              ? "webhook"
              : RESERVED_SANDBOX_VARIABLES.has(name)
                ? "reserved"
                : undefined;
          if (reason) result.missing.push({ name, reason });
          else deliverable.push(name);
        }
        const stored = await this.storedValues({
          tenantId: identity.tenantId,
          projectId,
          names: deliverable,
          owner,
        });
        for (const name of deliverable) {
          const values = stored.get(name);
          const fallback = declared.get(name)?.default;
          const [value, source] =
            values?.own !== undefined
              ? [values.own, "member" as const]
              : values?.shared !== undefined
                ? [values.shared, "shared" as const]
                : fallback !== undefined
                  ? [fallback, "default" as const]
                  : [undefined, undefined];
          if (value === undefined || source === undefined) {
            result.missing.push({ name, reason: "unset" });
            continue;
          }
          result.variables[name] = value;
          result.delivered.push({
            name,
            source,
            fingerprint: secretFingerprint(value),
          });
        }
        span.setAttribute(
          "catamorphic.secrets.delivered",
          result.delivered.length,
        );
        span.setAttribute("catamorphic.secrets.missing", result.missing.length);
        return result;
      },
    );
  }

  /**
   * Every stored value an Environment's sandbox could hold for `owner`:
   * the shared values and the owner's own. What a turn taken over from
   * another process masks in its output (ADR 0205), whichever it was given.
   */
  async valuesForMasking(opts: {
    identity: Identity;
    projectId: string;
    environment: string;
    owner: string | null;
  }): Promise<Record<string, string[]>> {
    const { identity, projectId } = opts;
    const manifest = await this.manifest({ identity, projectId });
    const names = manifest.environments[opts.environment] ?? [];
    const stored = await this.storedValues({
      tenantId: identity.tenantId,
      projectId,
      names,
      owner: opts.owner,
    });
    return Object.fromEntries(
      [...stored].map(([name, values]) => [
        name,
        [values.own, values.shared].filter(
          (value): value is string => value !== undefined,
        ),
      ]),
    );
  }

  /** Audit a delivery into a sandbox: names, sources and fingerprints only. */
  async auditDelivery(args: {
    identity: Identity;
    projectId: string;
    sessionId: string;
    allocationId?: string;
    delivered: SandboxSecrets["delivered"];
    missing: SandboxSecrets["missing"];
  }): Promise<void> {
    await this.audit({
      identity: args.identity,
      projectId: args.projectId,
      ...(args.allocationId ? { allocationId: args.allocationId } : {}),
      eventType: "project_secrets.deliver",
      metadata: {
        sessionId: args.sessionId,
        delivered: args.delivered.map(({ name, source, fingerprint }) => ({
          name,
          source,
          fingerprint,
        })),
        missing: args.missing.map(({ name, reason }) => ({ name, reason })),
      },
    });
  }

  private async audit(args: {
    identity: Identity;
    projectId: string;
    allocationId?: string;
    eventType: string;
    metadata: Json;
  }): Promise<void> {
    await this.db
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

/** A member of the project acting for themself, never the project. */
function requireMember(identity: Identity, projectId: string): void {
  if (
    !mayUseProject(identity, projectId) ||
    isProjectPrincipal(identity.externalUserId)
  )
    throw new AccessDeniedError();
}

/** Serialize writers of one value (shared, or one member's). */
async function lockValue(input: {
  trx: Transaction<DB>;
  projectId: string;
  name: string;
  member: string | null;
}): Promise<void> {
  const lock = `project-secret:${input.projectId}:${input.name}:${input.member ?? ""}`;
  await sql`select pg_advisory_xact_lock(hashtextextended(${lock}, 0))`.execute(
    input.trx,
  );
}
