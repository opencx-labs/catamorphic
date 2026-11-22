import type { Json } from "@catamorphic/db";
import {
  fetchIntoMirror,
  type GitCredentials,
  mirrorChangedFiles,
  type ProjectManager,
  unpinMirrorRef,
} from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import { z } from "zod";
import type { Identity } from "../identity.js";
import type { ResolvedConnectionBinding } from "./connection-types.js";

const tracer = getTracer("@catamorphic/core");

/**
 * Where a chat's workspace starts (ADR 0178): a branch, tag, commit, or
 * full ref such as `refs/pull/42/head` of the project's linked remote.
 * `update` says how a later delivery moves a chat already at another base:
 * `rebase` (default) replays the chat's own commits onto the new base,
 * `reset` discards them.
 */
export const SessionWorkspaceRequestSchema = z.strictObject({
  ref: z.string().trim().min(1).max(255),
  update: z.enum(["reset", "rebase"]).optional(),
});

export type SessionWorkspaceRequest = z.infer<
  typeof SessionWorkspaceRequestSchema
>;

/** The base a workspace stands on: the ref asked for and its commit. */
export interface SessionWorkspaceBase {
  ref: string;
  commit: string;
  /**
   * `origin`: a commit of the project's own `main`, which the host's
   * mirror of the linked repository does not pin (ADR 0344).
   */
  source?: "origin";
}

/** A base a later delivery asked for, applied before the next turn. */
export interface SessionWorkspaceMove extends SessionWorkspaceBase {
  update: "reset" | "rebase";
}

/** The mirror ref that keeps a session's current base. */
export function basePin(sessionId: string): string {
  return `refs/work/base/${sessionId}`;
}

/** The mirror ref that keeps a base a delivery asked to move to. */
export function movePin(sessionId: string): string {
  return `refs/work/move/${sessionId}`;
}

export function parseWorkspaceRequest(value: unknown): SessionWorkspaceRequest {
  const parsed = SessionWorkspaceRequestSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      'workspace must be { ref: "<branch, tag, commit, or refs/...>", update?: "reset" | "rebase" }',
    );
  return parsed.data;
}

export function parseWorkspaceBase(
  value: Json | null,
): SessionWorkspaceBase | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { ref, commit, source } = value;
  return typeof ref === "string" && typeof commit === "string"
    ? { ref, commit, ...(source === "origin" ? { source } : {}) }
    : null;
}

/**
 * What a new workspace's agent is told once, before its first turn: its
 * base is not the one its project would have given it (ADR 0344).
 */
export function workspaceNotice(value: Json | null): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return typeof value.notice === "string" ? value.notice : null;
}

export function parseWorkspaceMove(
  value: Json | null,
): SessionWorkspaceMove | null {
  const base = parseWorkspaceBase(value);
  if (!base || !value || typeof value !== "object" || Array.isArray(value))
    return null;
  const update = value.update === "reset" ? "reset" : "rebase";
  return { ...base, update };
}

export function workspaceJson(
  base: SessionWorkspaceBase,
  notice?: string,
): Json {
  return {
    ref: base.ref,
    commit: base.commit,
    ...(base.source ? { source: base.source } : {}),
    ...(notice ? { notice } : {}),
  };
}

export function workspaceMoveJson(move: SessionWorkspaceMove): Json {
  return { ref: move.ref, commit: move.commit, update: move.update };
}

/**
 * What the agent is told when a delivery asked for a base its checkout may
 * not move to: the folder is a person's own, not the chat's (ADR 0178).
 */
export function workspaceMoveRefusedNote(input: {
  to: SessionWorkspaceBase;
}): string {
  return `[Workspace] A delivery asked to move this workspace to ${input.to.ref} at ${input.to.commit.slice(0, 12)}. This chat works in a folder it does not own, so nothing was moved. Fetch that ref yourself if you need it.`;
}

/** What the agent is told before a turn whose workspace base moved. */
export function workspaceMoveNote(input: {
  from: SessionWorkspaceBase | null;
  to: SessionWorkspaceBase;
  update: "reset" | "rebase";
  outcome:
    | { status: "moved"; head: string }
    | { status: "conflict"; head: string; files: string[] };
  changed: { files: string[]; total: number } | null;
}): string {
  const short = (commit: string) => commit.slice(0, 12);
  const from = input.from
    ? `${input.from.ref} at ${short(input.from.commit)}`
    : "where it was";
  const lines = [
    `[Workspace] The base of this workspace moved from ${from} to ${input.to.ref} at ${short(input.to.commit)}.`,
  ];
  if (input.outcome.status === "conflict") {
    lines.push(
      `Rebasing your commits onto it stopped on conflicts in ${input.outcome.files.join(", ") || "some files"}, so nothing was changed: your checkout is still at ${short(input.outcome.head)}. The new base is available as refs/work/base; rebase onto it and resolve the conflicts if you need the new changes.`,
    );
  } else if (input.update === "reset") {
    lines.push(
      `Your checkout was reset to the new base; earlier local changes and commits were discarded.`,
    );
  } else {
    lines.push(
      "Your commits were rebased onto it, on the branch you were on, and your uncommitted changes are in your working tree as before.",
    );
  }
  if (input.changed && input.changed.total > 0) {
    const more = input.changed.total - input.changed.files.length;
    lines.push(
      `Changed between the two bases: ${input.changed.files.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`,
    );
  }
  return lines.join("\n");
}

/**
 * Fetches refs of a project's linked remote into the host's mirror of it
 * (ADR 0178), with the origin's credentials, on the control plane. Sandboxes
 * never see those credentials; they are seeded from what the mirror holds.
 */
export class SessionWorkspaces {
  constructor(
    private readonly deps: {
      projectManager: ProjectManager;
      /** The project's linked remote and the credentials to fetch it with. */
      origin: (input: { identity: Identity; projectId: string }) => Promise<{
        url: string;
        /** The repository's default branch: where a chat starts. */
        branch?: string;
        credentials?: GitCredentials;
      } | null>;
      /**
       * Credentials from a session's own Git-capable binding for the
       * remote, preferred over the host's code-host credentials.
       */
      bindingCredentials?: (input: {
        identity: Identity;
        projectId: string;
        bindings: readonly ResolvedConnectionBinding[];
        remoteUrl: string;
      }) => Promise<GitCredentials | undefined>;
    },
  ) {}

  mirrorPath(input: { tenantId: string; projectId: string }): string {
    const path = this.deps.projectManager.mirrorPath(input);
    if (!path)
      throw new Error(
        "This host keeps no project mirror, so workspaces cannot start at a ref",
      );
    return path;
  }

  /** Fetch `ref` and pin the commit it names for the session. */
  async fetch(input: {
    identity: Identity;
    projectId: string;
    sessionId: string;
    ref: string;
    pin: string;
    /** The session's connection bindings, when it has any. */
    bindings?: readonly ResolvedConnectionBinding[];
  }): Promise<SessionWorkspaceBase> {
    return withSpan(
      {
        tracer,
        name: "agent.session.workspace.fetch",
        attributes: {
          "catamorphic.project.id": input.projectId,
          "catamorphic.tenant.id": input.identity.tenantId,
          "catamorphic.agent.session.id": input.sessionId,
          "catamorphic.git.ref": input.ref,
        },
      },
      async () => {
        const origin = await this.deps.origin({
          identity: input.identity,
          projectId: input.projectId,
        });
        if (!origin)
          throw new Error(
            `This project has no linked remote to fetch '${input.ref}' from`,
          );
        const viaBinding =
          input.bindings?.length && this.deps.bindingCredentials
            ? await this.deps.bindingCredentials({
                identity: input.identity,
                projectId: input.projectId,
                bindings: input.bindings,
                remoteUrl: origin.url,
              })
            : undefined;
        const credentials = viaBinding ?? origin.credentials;
        const { commit } = await fetchIntoMirror({
          mirrorPath: this.mirrorPath({
            tenantId: input.identity.tenantId,
            projectId: input.projectId,
          }),
          url: origin.url,
          ...(credentials ? { credentials } : {}),
          ref: input.ref,
          pin: input.pin,
        });
        return { ref: input.ref, commit };
      },
    );
  }

  /**
   * Where a chat that named no ref starts (ADR 0344): the default branch
   * of the project's linked repository, fetched now; without one, or when
   * it cannot be reached, the project's own `main`. `notice` says what the
   * agent must know about a base that is not the repository's.
   */
  async defaultBase(input: {
    identity: Identity;
    projectId: string;
    sessionId: string;
    bindings?: readonly ResolvedConnectionBinding[];
  }): Promise<{ base: SessionWorkspaceBase; notice?: string }> {
    const own = async (): Promise<SessionWorkspaceBase> => ({
      ref: "main",
      commit: await this.deps.projectManager.mainCommit({
        tenantId: input.identity.tenantId,
        projectId: input.projectId,
      }),
      source: "origin",
    });
    const origin = await this.deps
      .origin({ identity: input.identity, projectId: input.projectId })
      .catch(() => null);
    if (!origin) return { base: await own() };
    const branch = origin.branch ?? "main";
    try {
      return {
        base: await this.fetch({
          ...input,
          ref: branch,
          pin: basePin(input.sessionId),
        }),
      };
    } catch (error) {
      const base = await own();
      const why = error instanceof Error ? error.message : String(error);
      return {
        base,
        notice: `[Workspace] The project's repository could not be reached when this chat started (${why.slice(0, 300)}), so this workspace stands on Work's own copy of the project (main at ${base.commit.slice(0, 12)}) and not on ${branch} as the repository has it now. Fetch ${branch} from origin and rebase onto it once the repository is reachable.`,
      };
    }
  }

  async changedFiles(input: {
    tenantId: string;
    projectId: string;
    from: string;
    to: string;
  }): Promise<{ files: string[]; total: number } | null> {
    const mirrorPath = this.deps.projectManager.mirrorPath(input);
    if (!mirrorPath) return null;
    return mirrorChangedFiles({
      mirrorPath,
      from: input.from,
      to: input.to,
      limit: 30,
    });
  }

  /** Forget a closed session's pins. */
  async release(input: {
    tenantId: string;
    projectId: string;
    sessionId: string;
  }): Promise<void> {
    const mirrorPath = this.deps.projectManager.mirrorPath(input);
    if (!mirrorPath) return;
    await unpinMirrorRef({ mirrorPath, pin: basePin(input.sessionId) });
    await unpinMirrorRef({ mirrorPath, pin: movePin(input.sessionId) });
  }
}
