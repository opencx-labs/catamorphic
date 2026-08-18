import type { CatamorphicCore, Identity } from "@catamorphic/core";
import {
  AccessDeniedError,
  isBuilder,
  projectAgentId,
  resolveScope,
} from "@catamorphic/core";
import { toolError, toolValue } from "./mcp-shared.js";

/**
 * The project's "bring your own agent" surface (ADR 0055): everything a
 * caller's scope covers, as MCP tools beside the workflow tools —
 *
 * - documents: list / read / search / write / delete / history over the one
 *   path namespace (program + store), each narrowed to the caller's
 *   document refs by `DocumentsService` itself;
 * - skills: list / read, for anyone who may use the project (a builder, or
 *   a member with an agent ref);
 * - agents: `ask_agent` — a synchronous chat turn with a project agent the
 *   caller may open sessions on (`AgentSessionsService` enforces the ref).
 *
 * Nothing here checks scope by hand: every call goes through the core
 * service that already enforces it, with the request's identity.
 */

const READ_ONLY = { readOnlyHint: true } as const;

export interface SurfaceTool {
  definition: Record<string, unknown>;
  call: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/** Whether this identity may use the project at all (documents/skills/agents). */
export function mayUseProject(identity: Identity, projectId: string): boolean {
  if (isBuilder(identity, projectId)) return true;
  return (identity.scope ?? []).some(
    (ref) =>
      ref.projectId === projectId &&
      (ref.kind === "agent" ||
        ref.kind === "document" ||
        ref.kind === "workflow"),
  );
}

/** Workflow names a scoped caller may see on the tools list; null = all. */
export async function allowedWorkflowNames(
  core: CatamorphicCore,
  identity: Identity,
  projectId: string,
): Promise<ReadonlySet<string> | null> {
  const resolved = await resolveScope({
    db: core.db,
    identity,
    projectId,
    policies: core.appPolicies,
  });
  return resolved?.allowedWorkflows ?? null;
}

export function surfaceTools(
  core: CatamorphicCore,
  identity: Identity,
  projectId: string,
): SurfaceTool[] {
  const tools: SurfaceTool[] = [];
  const guarded =
    (fn: (args: Record<string, unknown>) => Promise<unknown>) =>
    async (args: Record<string, unknown>) => {
      try {
        return toolValue(await fn(args));
      } catch (error) {
        if (error instanceof AccessDeniedError) {
          return toolError("Not authorized for that path or agent.");
        }
        return toolError(
          error instanceof Error ? error.message : String(error),
        );
      }
    };
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const int = (v: unknown) =>
    typeof v === "number" && Number.isInteger(v) ? v : undefined;

  if (core.documents) {
    const documents = core.documents;
    tools.push(
      {
        definition: {
          name: "documents_list",
          description:
            "List the project's documents you may read — the program (docs, handbook, code, at the shared main) and the project store (store/…, per-customer notes, contracts, generated files; versioned, with author). Narrow with a prefix.",
          inputSchema: {
            type: "object",
            properties: {
              prefix: {
                type: "string",
                description:
                  "Directory prefix, e.g. docs or store/customers/acme",
              },
              source: { type: "string", enum: ["program", "store"] },
            },
          },
          annotations: READ_ONLY,
        },
        call: guarded(async (args) =>
          documents.list({
            identity,
            projectId,
            ...(str(args.prefix) ? { prefix: str(args.prefix) } : {}),
            ...(args.source === "program" || args.source === "store"
              ? { source: args.source }
              : {}),
          }),
        ),
      },
      {
        definition: {
          name: "documents_read",
          description:
            "Read one document (text content when text-like; metadata always). Store documents accept a version to read history.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
              version: { type: "integer" },
            },
            required: ["path"],
          },
          annotations: READ_ONLY,
        },
        call: guarded(async (args) => {
          const doc = await documents.read({
            identity,
            projectId,
            path: str(args.path) ?? "",
            ...(int(args.version) !== undefined
              ? { version: int(args.version) }
              : {}),
          });
          const { bytes: _bytes, ...rest } = doc;
          return rest;
        }),
      },
      {
        definition: {
          name: "documents_search",
          description:
            "Search documents you may read. mode=grep (default): case-insensitive literal substring; mode=text: full-text, words in any order. Returns matching lines with line numbers. Prefer several small greps to one broad query.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              mode: { type: "string", enum: ["grep", "text"] },
              prefix: { type: "string" },
              limit: { type: "integer" },
            },
            required: ["query"],
          },
          annotations: READ_ONLY,
        },
        call: guarded(async (args) =>
          documents.search({
            identity,
            projectId,
            query: str(args.query) ?? "",
            ...(args.mode === "grep" || args.mode === "text"
              ? { mode: args.mode }
              : {}),
            ...(str(args.prefix) ? { prefix: str(args.prefix) } : {}),
            ...(int(args.limit) !== undefined
              ? { limit: int(args.limit) }
              : {}),
          }),
        ),
      },
      {
        definition: {
          name: "documents_write",
          description:
            "Write a store document (paths under store/ only; the program changes by commit). Give text, or base64 for binary content (a PDF, an image). Creates a new version stamped with you. Pass ifVersion (the version you read) to refuse overwriting someone else's newer write; 0 means 'must not exist yet'.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
              text: { type: "string" },
              base64: {
                type: "string",
                description: "Binary content, base64-encoded (instead of text)",
              },
              contentType: { type: "string" },
              ifVersion: { type: "integer" },
            },
            required: ["path"],
          },
        },
        call: guarded(async (args) =>
          documents.write({
            identity,
            projectId,
            path: str(args.path) ?? "",
            content:
              str(args.text) !== undefined
                ? (str(args.text) as string)
                : new Uint8Array(Buffer.from(str(args.base64) ?? "", "base64")),
            ...(str(args.contentType)
              ? { contentType: str(args.contentType) }
              : {}),
            ...(int(args.ifVersion) !== undefined
              ? { ifVersion: int(args.ifVersion) }
              : {}),
          }),
        ),
      },
      {
        definition: {
          name: "documents_delete",
          description:
            "Delete a store document (a tombstone version; history stays readable).",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
              ifVersion: { type: "integer" },
            },
            required: ["path"],
          },
          annotations: { destructiveHint: true },
        },
        call: guarded(async (args) =>
          documents.delete({
            identity,
            projectId,
            path: str(args.path) ?? "",
            ...(int(args.ifVersion) !== undefined
              ? { ifVersion: int(args.ifVersion) }
              : {}),
          }),
        ),
      },
      {
        definition: {
          name: "documents_history",
          description:
            "A store document's versions, newest first, with who wrote each.",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          annotations: READ_ONLY,
        },
        call: guarded(async (args) =>
          documents.history({
            identity,
            projectId,
            path: str(args.path) ?? "",
          }),
        ),
      },
    );
  }

  if (core.skills && mayUseProject(identity, projectId)) {
    const skills = core.skills;
    tools.push(
      {
        definition: {
          name: "list_skills",
          description:
            "List the project's skills (how-to guides for working in this project) and the host's, by name with a one-line description.",
          inputSchema: { type: "object", properties: {} },
          annotations: READ_ONLY,
        },
        call: guarded(async () =>
          (await skills.listShared(identity, projectId)).map((skill) => ({
            name: skill.name,
            title: skill.title,
            description: skill.description,
            source: skill.source,
          })),
        ),
      },
      {
        definition: {
          name: "read_skill",
          description: "Read a skill's full SKILL.md by name.",
          inputSchema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
          annotations: READ_ONLY,
        },
        call: guarded(async (args) => {
          const found = await skills.readShared(
            identity,
            projectId,
            str(args.name) ?? "",
          );
          if (!found) throw new Error(`No skill named '${String(args.name)}'`);
          return { ...found.skill, content: found.content };
        }),
      },
    );
  }

  if (core.publications) {
    const publications = core.publications;
    tools.push(
      {
        definition: {
          name: "publish_document",
          description:
            "Share a document by URL. audience=members: anyone who may use this project, behind the host's login; audience=public: anyone with the link (anonymous, that one document only). Builders publish anything they can read; members only store documents they may write. Returns the URL path (relative to the host's API base) and the slug to revoke with.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
              audience: { type: "string", enum: ["public", "members"] },
              slug: { type: "string", description: "Optional readable handle" },
            },
            required: ["path", "audience"],
          },
        },
        call: guarded(async (args) => {
          const audience = args.audience === "public" ? "public" : "members";
          const publication = await publications.publish({
            identity,
            projectId,
            path: str(args.path) ?? "",
            audience,
            ...(str(args.slug) ? { slug: str(args.slug) } : {}),
          });
          return {
            ...publication,
            url:
              audience === "public"
                ? `/public/${projectId}/${publication.slug}`
                : `/projects/${projectId}/publications/${publication.slug}`,
          };
        }),
      },
      {
        definition: {
          name: "revoke_publication",
          description:
            "Revoke a shared URL by slug; the link stops working immediately.",
          inputSchema: {
            type: "object",
            properties: { slug: { type: "string" } },
            required: ["slug"],
          },
          annotations: { destructiveHint: true },
        },
        call: guarded(async (args) => {
          await publications.revoke({
            identity,
            projectId,
            slug: str(args.slug) ?? "",
          });
          return { revoked: true };
        }),
      },
      {
        definition: {
          name: "list_publications",
          description:
            "The shared URLs you may see (builders: all of the project's; members: your own).",
          inputSchema: { type: "object", properties: {} },
          annotations: READ_ONLY,
        },
        call: guarded(async () => publications.list({ identity, projectId })),
      },
    );
  }

  if (core.proposals && mayUseProject(identity, projectId)) {
    const proposals = core.proposals;
    tools.push({
      definition: {
        name: "propose_change",
        description:
          "Propose a change to the program — docs, templates, workflows, anything outside store/ — when you cannot commit directly. The files land on a branch from the shared main authored as the caller, and a pull request opens on the caller's behalf when the project is linked to a code host. Give a clear title and, for each change, the full new content (or delete: true).",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            body: { type: "string" },
            changes: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  content: { type: "string" },
                  delete: { type: "boolean" },
                },
                required: ["path"],
              },
            },
          },
          required: ["title", "changes"],
        },
      },
      call: guarded(async (args) => {
        const changes = Array.isArray(args.changes)
          ? (args.changes as Array<Record<string, unknown>>)
          : [];
        return proposals.propose({
          identity,
          projectId,
          title: str(args.title) ?? "",
          ...(str(args.body) ? { body: str(args.body) } : {}),
          changes: changes.map((change) => ({
            path: str(change.path) ?? "",
            ...(typeof change.content === "string"
              ? { content: change.content }
              : {}),
            ...(change.delete === true ? { delete: true } : {}),
          })),
        });
      }),
    });
  }

  if (core.agentSessions) {
    const sessions = core.agentSessions;
    const agentNames = (identity.scope ?? [])
      .filter((ref) => ref.kind === "agent" && ref.projectId === projectId)
      .map((ref) => (ref as { name: string }).name);
    const hint = isBuilder(identity, projectId)
      ? "any committed project agent (agents/<slug>.json)"
      : agentNames.length > 0
        ? `one of: ${agentNames.join(", ")}`
        : "none available to you";
    tools.push({
      definition: {
        name: "ask_agent",
        description: `Ask one of the project's agents (${hint}) and get its reply — a full turn with the agent's own tools and persona. Pass sessionId to continue an earlier conversation.`,
        inputSchema: {
          type: "object",
          properties: {
            agent: { type: "string", description: "The agent's slug" },
            message: { type: "string" },
            sessionId: { type: "string" },
          },
          required: ["agent", "message"],
        },
      },
      call: guarded(async (args) => {
        const agent = str(args.agent);
        const message = str(args.message);
        if (!agent || !message)
          throw new Error("agent and message are required");
        const agentId = projectAgentId(projectId, agent);
        const sessionId =
          str(args.sessionId) ??
          (await sessions.create(identity, projectId, { agentId })).id;
        const reply = await sessions.sendMessage(
          identity,
          projectId,
          sessionId,
          message,
        );
        return { sessionId, reply: reply.content };
      }),
    });
  }

  return tools;
}
