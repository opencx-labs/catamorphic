import { createHash } from "node:crypto";
import type { DB } from "@catamorphic/db";
import type { ProjectManager, ProjectRepo } from "@catamorphic/git";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { Identity } from "../identity.js";
import { ProjectNotFoundError } from "./projects-service.js";

/**
 * Directory (relative to the project root) where committed project agent
 * definitions live:
 *
 * ```
 * agents/<slug>.json   # the definition (schema below)
 * agents/<slug>.md     # optional persona / system-prompt file, same slug
 * ```
 *
 * The directory is VISIBLE (unlike `.agents/skills/`): project agents are
 * work products the team authors and reviews, and in the lazy spirit of
 * ADR 0043 the directory exists only once someone creates an agent — a
 * project without agents carries nothing.
 *
 * A committed definition is collaborator-authored code. Hosts must not run
 * one against a user's personal credentials without that user's explicit,
 * definition-hash-bound consent (see {@link definitionHash} and ADR 0050).
 */
export const AGENT_DEFINITIONS_DIR = "agents";

/**
 * Harness kinds a project agent may declare:
 *  - `claude-code` / `codex`: the CLI harnesses, host execution.
 *  - `builtin`: the embedder's built-in sandboxed agent.
 *  - `acp`: an Agent Client Protocol harness (local command or remote
 *    endpoint). Validates today, resolves to an "unsupported yet" registry
 *    entry — designed in, built later (see TODO.md "ACP harness").
 *  - `e2e-fake`: the desktop e2e scripted harness. Only accepted when the
 *    host passes `allowE2eFake` (the desktop gates it on
 *    CATAMORPHIC_E2E_FAKE_AGENT=1), mirroring the pick-folder e2e seam —
 *    real installs never validate it.
 */
export const AGENT_DEFINITION_KINDS = [
  "claude-code",
  "codex",
  "builtin",
  "acp",
] as const;
export type AgentDefinitionKind =
  | (typeof AGENT_DEFINITION_KINDS)[number]
  | "e2e-fake";

/**
 * How a project agent authenticates:
 *  - `profile` (default): the running user's own personal credentials — the
 *    profile's matching auth for the harness. Requires per-user consent.
 *  - `secret`: a project secret (declared via `defineSecrets`, ADR 0033)
 *    named in `secret` holds the API key. No personal consent needed — the
 *    secret's presence IS the authorization, and nothing personal is used.
 *    The mode for shared/remote deployments.
 *  - `local`: the machine's existing CLI login (`claude login` /
 *    `codex login`), no credential overrides. Personal too → consent.
 */
export const AgentDefinitionCredentialsSchema = z
  .object({
    source: z.enum(["profile", "secret", "local"]).default("profile"),
    /** Project-secret name holding the API key (source: "secret" only). */
    secret: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.source === "secret" && !value.secret) {
      ctx.addIssue({
        code: "custom",
        path: ["secret"],
        message: 'credentials.source "secret" requires a "secret" name',
      });
    }
    if (value.source !== "secret" && value.secret) {
      ctx.addIssue({
        code: "custom",
        path: ["secret"],
        message: `"secret" is only valid with credentials.source "secret"`,
      });
    }
  });

export type AgentDefinitionCredentials = z.infer<
  typeof AgentDefinitionCredentialsSchema
>;

/**
 * The committed `agents/<slug>.json` schema, version 1. Unknown top-level
 * keys are stripped (forward compatibility inside a version); a bumped
 * `version` is reported as an invalid entry with a clear error rather
 * than half-parsed.
 */
export function agentDefinitionSchema(opts?: { allowE2eFake?: boolean }) {
  const kinds = opts?.allowE2eFake
    ? ([...AGENT_DEFINITION_KINDS, "e2e-fake"] as const)
    : AGENT_DEFINITION_KINDS;
  return z.object({
    version: z.literal(1),
    /** Display name. */
    name: z.string().min(1),
    kind: z.enum(kinds as readonly [string, ...string[]]),
    model: z.string().min(1).optional(),
    effort: z.enum(["low", "medium", "high"]).optional(),
    description: z.string().optional(),
    credentials: AgentDefinitionCredentialsSchema.optional(),
    /**
     * Connector names this agent expects. Informational in v1: shown in
     * the host UI so a user knows what to connect; enforcement later.
     */
    connections: z.array(z.string().min(1)).optional(),
    /** Reserved for kind "acp": how to reach the agent. */
    acp: z
      .object({
        endpoint: z.string().min(1).optional(),
        command: z.array(z.string().min(1)).optional(),
      })
      .optional(),
  });
}

export const AgentDefinitionSchema = agentDefinitionSchema();

export interface AgentDefinition {
  version: 1;
  name: string;
  kind: AgentDefinitionKind;
  model?: string;
  effort?: "low" | "medium" | "high";
  description?: string;
  credentials?: AgentDefinitionCredentials;
  connections?: string[];
  acp?: { endpoint?: string; command?: string[] };
}

export interface ProjectAgentEntry {
  /** File name minus `.json`; doubles as the persona file's base name. */
  slug: string;
  /** Present when the file parsed and validated. */
  definition?: AgentDefinition;
  /** Content of the sibling `agents/<slug>.md` persona file, if present. */
  promptFile?: string;
  /** Present instead of `definition` when the file could not be used. */
  invalid?: { error: string };
}

/** Slugs must be filesystem- and registry-id-safe (`project:<id>:<slug>`). */
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Validate one raw definition (already JSON-parsed). Returns the parsed
 * definition or a human-readable error — never throws.
 */
export function validateAgentDefinition(
  raw: unknown,
  opts?: { allowE2eFake?: boolean },
): { definition: AgentDefinition } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "Definition must be a JSON object" };
  }
  const version = (raw as { version?: unknown }).version;
  if (version !== 1) {
    return {
      error: `Unsupported definition version ${JSON.stringify(version)} (this build supports version 1)`,
    };
  }
  const parsed = agentDefinitionSchema(opts).safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue?.path.length ? ` at "${issue.path.join(".")}"` : "";
    return { error: `${issue?.message ?? "Invalid definition"}${at}` };
  }
  return { definition: parsed.data as AgentDefinition };
}

/**
 * Stable hash over a definition's SENSITIVE fields plus the persona file:
 * what runs (kind, model, acp transport), on whose credentials, and with
 * what instructions. A host stores this hash with a user's consent record;
 * any change to a covered field makes stored consent stale, forcing
 * re-consent before the definition can touch personal credentials again.
 *
 * Deliberately NOT covered: name, description, connections — display
 * concerns whose edits must not invalidate consent.
 */
export function definitionHash(
  definition: AgentDefinition,
  promptContent?: string,
): string {
  const credentials = definition.credentials ?? { source: "profile" as const };
  const sensitive = {
    kind: definition.kind,
    model: definition.model ?? null,
    credentials: {
      source: credentials.source,
      secret: credentials.secret ?? null,
    },
    acp: definition.acp
      ? {
          endpoint: definition.acp.endpoint ?? null,
          command: definition.acp.command ?? null,
        }
      : null,
    prompt:
      promptContent !== undefined
        ? createHash("sha256").update(promptContent, "utf8").digest("hex")
        : null,
  };
  // Key order above is fixed, so JSON.stringify is canonical here.
  return createHash("sha256")
    .update(JSON.stringify(sensitive), "utf8")
    .digest("hex");
}

/**
 * Read-only view over a project's committed `agents/` directory. Writes go
 * through the normal project file APIs (definitions are just files in the
 * repo). Mirrors {@link SkillsService}: reads the caller's dev working copy
 * so uncommitted edits are visible, and NEVER throws on a bad file — each
 * unusable definition is reported as an invalid entry so one typo can't
 * take down the whole roster.
 */
export class AgentDefinitionsService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly projectManager: ProjectManager,
    private readonly opts?: { allowE2eFake?: boolean },
  ) {}

  async list(
    identity: Identity,
    projectId: string,
  ): Promise<ProjectAgentEntry[]> {
    await this.requireProject(identity, projectId);
    return this.withDev(identity, projectId, async (repo) => {
      const files = await repo.listFiles();
      const prefix = `${AGENT_DEFINITIONS_DIR}/`;
      const definitionFiles = files.filter(
        (file) =>
          file.startsWith(prefix) &&
          file.endsWith(".json") &&
          !file.slice(prefix.length).includes("/"),
      );
      const markdown = new Set(
        files.filter(
          (file) =>
            file.startsWith(prefix) &&
            file.endsWith(".md") &&
            !file.slice(prefix.length).includes("/"),
        ),
      );

      const entries = await Promise.all(
        definitionFiles.map(async (file): Promise<ProjectAgentEntry> => {
          const slug = file.slice(prefix.length, -".json".length);
          if (!SLUG_PATTERN.test(slug)) {
            return {
              slug,
              invalid: {
                error: `Invalid agent file name "${slug}.json" (use letters, digits, ".", "_", "-")`,
              },
            };
          }
          const promptPath = `${prefix}${slug}.md`;
          const promptFile = markdown.has(promptPath)
            ? await repo.readFile(promptPath)
            : undefined;
          let raw: unknown;
          try {
            raw = JSON.parse(await repo.readFile(file));
          } catch (cause) {
            return {
              slug,
              ...(promptFile !== undefined ? { promptFile } : {}),
              invalid: {
                error: `Not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
              },
            };
          }
          const result = validateAgentDefinition(raw, this.opts);
          if ("error" in result) {
            return {
              slug,
              ...(promptFile !== undefined ? { promptFile } : {}),
              invalid: { error: result.error },
            };
          }
          return {
            slug,
            definition: result.definition,
            ...(promptFile !== undefined ? { promptFile } : {}),
          };
        }),
      );

      return entries.sort((a, b) => a.slug.localeCompare(b.slug));
    });
  }

  private async requireProject(
    identity: Identity,
    projectId: string,
  ): Promise<void> {
    const row = await this.db
      .selectFrom("projects")
      .where("id", "=", projectId)
      .where("tenant_id", "=", identity.tenantId)
      .select("id")
      .executeTakeFirst();
    if (!row) throw new ProjectNotFoundError(projectId);
  }

  private async withDev<T>(
    identity: Identity,
    projectId: string,
    fn: (repo: ProjectRepo) => Promise<T>,
  ): Promise<T> {
    const repo = await this.projectManager.openDev(
      identity.tenantId,
      projectId,
      identity.externalUserId,
    );
    try {
      return await fn(repo);
    } finally {
      await repo.dispose();
    }
  }
}
