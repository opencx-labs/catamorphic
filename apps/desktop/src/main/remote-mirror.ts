import {
  isWorking,
  queuedTurns,
  sessionStateFromSnapshot,
} from "@catamorphic/agent-protocol";
import {
  type AgentSession,
  type AgentSessionDetail,
  type AgentSessionsService,
  type Identity,
  parseProjectAgentId,
  type SessionMailboxItem,
  type SessionSyncService,
} from "@catamorphic/core";
import { z } from "zod";
import type { ProfileConfigManager } from "./profile-config.js";
import type { ProfilesStore } from "./profiles.js";
import { refreshRemoteCredentials } from "./remote-oauth.js";
import type { RemoteProjectsStore } from "./remote-projects-store.js";

/**
 * One mirror push (ADR 0195). Core's entry does not export the type, so it
 * is read off the service method that accepts it.
 */
type SessionMirrorInput = Parameters<AgentSessionsService["mirror"]>[3];

/** What the local log contributes to a push: a base, the events, or both. */
export type SessionMirrorExport = Pick<
  SessionMirrorInput,
  "base" | "events" | "projectEvents"
>;

/** Rounds of `behind` or short answers one push follows before giving up. */
const MAX_PUSH_ROUNDS = 5;

/**
 * Session mirroring (ADR 0195, superseding ADR 0061's transport):
 * local-first, synced to the linked remote. After every settled turn on a
 * remote-linked project, the session's log events after the remote's
 * acknowledged sequence are pushed to the remote's mirror route, which
 * applies them through the same projector; a remote without a copy gets a
 * base snapshot first. A phone connected to the remote server sees the
 * desktop's chats and, when this desktop is asleep, continues them there.
 *
 * Where the remote is: the last sequence it acknowledged for this
 * destination, learned from its answers in this process or, on the first
 * push, from the durable sync receipt. A 409 `behind` names the remote's
 * real sequence and the push resends from there.
 *
 * Fork rule: the first 409 `diverged` means someone continued the session
 * on the server. The server owns that conversation now, and this desktop
 * stops pushing it (remembered per session for the process lifetime;
 * a restart re-learns it from the same 409).
 */
export class RemoteSessionMirror {
  private readonly diverged = new Set<string>();
  /** The remote's acknowledged sequence, per destination and session. */
  private readonly remoteSequences = new Map<string, number>();
  private readonly inflight = new Set<string>();
  private mailboxSyncRunning = false;
  private syncDrainRunning = false;
  private readonly syncWorkerId: string;

  constructor(
    private readonly deps: {
      hostId: string;
      identity?: Identity;
      getSessionSync?: () => SessionSyncService | undefined;
      profiles: ProfilesStore;
      profileConfig: ProfileConfigManager;
      /** Desktop-local privacy flag (ADR 0062): skip these entirely. */
      isIncognito: (sessionId: string) => boolean;
      /** Record an inherited flag (a fork of an incognito chat). */
      markIncognito: (sessionId: string) => void;
      /** The session and its snapshot, under the desktop identity. */
      sessionDetail: (
        projectId: string,
        sessionId: string,
      ) => Promise<AgentSessionDetail>;
      /**
       * The local log after `after` (null: a full base snapshot), under
       * the desktop identity.
       */
      exportMirror: (input: {
        projectId: string;
        sessionId: string;
        after: number | null;
      }) => Promise<SessionMirrorExport>;
      listSessions?: (projectId: string) => Promise<AgentSession[]>;
      beginHandoff?: (
        projectId: string,
        sessionId: string,
        destinationHostId: string,
      ) => Promise<AgentSession>;
      cancelHandoff?: (
        projectId: string,
        sessionId: string,
      ) => Promise<AgentSession>;
      completeHandoff?: (
        projectId: string,
        sessionId: string,
        destinationHostId: string,
        authorityRevision: number,
      ) => Promise<AgentSession>;
      /**
       * Stamp the local copy with the fork marker (ADR 0062) once the
       * remote reports divergence — the visible "continued on <host>"
       * system row clients use to lock the stale copy.
       */
      markFork: (
        projectId: string,
        sessionId: string,
        fork: { serverUrl: string; remoteProjectId: string },
      ) => Promise<void>;
      importMailbox: (
        projectId: string,
        item: SessionMailboxItem,
      ) => Promise<unknown>;
    },
  ) {
    this.syncWorkerId = `desktop-session-sync:${deps.hostId}`;
  }

  async eligibility(
    projectId: string,
    sessionId: string,
  ): Promise<{ canMove: boolean; reason: string | null }> {
    if (this.deps.isIncognito(sessionId)) {
      return {
        canMove: false,
        reason: "Incognito sessions stay on this machine",
      };
    }
    const link = this.linkFor(projectId);
    if (!link) {
      return { canMove: false, reason: "Link this project to a server first" };
    }
    const detail = await this.deps.sessionDetail(projectId, sessionId);
    if (detail.status !== "active") {
      return { canMove: false, reason: "This session is closed" };
    }
    const state = sessionStateFromSnapshot(detail.snapshot);
    if (detail.running || isWorking(state) || queuedTurns(state).length > 0) {
      return { canMove: false, reason: "Wait for the current work to finish" };
    }
    if (detail.authorityHostId !== this.deps.hostId) {
      return {
        canMove: false,
        reason: "This session already runs on another machine",
      };
    }
    try {
      const response = await this.remoteRequest(link, {
        url: `${link.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(
          link.remoteProjectId,
        )}/agent/sessions?limit=1`,
        method: "GET",
      });
      if (!response.ok) {
        return {
          canMove: false,
          reason:
            response.status === 503
              ? "This server cannot run agent sessions"
              : "The linked server is unavailable",
        };
      }
    } catch {
      return { canMove: false, reason: "The linked server is unavailable" };
    }
    return { canMove: true, reason: null };
  }

  async moveToServer(
    projectId: string,
    sessionId: string,
  ): Promise<{ ok: true; serverUrl: string; remoteProjectId: string }> {
    const eligibility = await this.eligibility(projectId, sessionId);
    if (!eligibility.canMove) {
      throw new Error(
        eligibility.reason ?? "This session cannot move right now",
      );
    }
    const link = this.linkFor(projectId);
    const sync = this.deps.getSessionSync?.();
    if (
      !link ||
      !sync ||
      !this.deps.identity ||
      !this.deps.beginHandoff ||
      !this.deps.completeHandoff
    ) {
      throw new Error("Durable session handoff is unavailable");
    }
    const destinationHostId = `remote:${new URL(link.serverUrl).host}`;
    const pending = await this.deps.beginHandoff(
      projectId,
      sessionId,
      destinationHostId,
    );
    let remoteClaimed = false;
    let remoteClaimMayHaveCommitted = false;
    try {
      await sync.enqueue({
        identity: this.deps.identity,
        projectId,
        sessionId,
        destinationKey: destinationKey(link),
      });
      await this.drainMirrors();
      const status = await sync.status({
        identity: this.deps.identity,
        projectId,
        sessionId,
        destinationKey: destinationKey(link),
      });
      if (
        status?.state !== "acknowledged" ||
        status.acknowledgedAuthorityRevision !== pending.authorityRevision
      ) {
        if (status?.state === "diverged") {
          remoteClaimMayHaveCommitted = true;
          const remote = await this.remoteSession(link, sessionId);
          if (
            remoteAuthorityOwnsSnapshot({
              remote,
              sourceHostId: this.deps.hostId,
              sourceRevision: pending.authorityRevision,
              desiredSequence: status.desiredSequence,
            })
          ) {
            remoteClaimed = true;
            return this.finishMove(projectId, sessionId, link, remote);
          }
        }
        throw new Error(
          status?.lastError ?? "The transcript did not finish syncing",
        );
      }
      remoteClaimMayHaveCommitted = true;
      const response = await this.remoteRequest(link, {
        url: `${link.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(
          link.remoteProjectId,
        )}/agent/sessions/${encodeURIComponent(sessionId)}/resume`,
        method: "POST",
        body: JSON.stringify({
          expectedAuthorityRevision: pending.authorityRevision,
        }),
      });
      const remote = response.ok
        ? parseRemoteSession(await response.json().catch(() => null))
        : await this.remoteSession(link, sessionId).catch(() => null);
      if (
        !remote ||
        !remoteAuthorityOwnsSnapshot({
          remote,
          sourceHostId: this.deps.hostId,
          sourceRevision: pending.authorityRevision,
          desiredSequence: status.desiredSequence,
        })
      ) {
        throw new Error(
          `The server could not resume this session (${response.status})`,
        );
      }
      remoteClaimed = true;
      return this.finishMove(projectId, sessionId, link, remote);
    } catch (error) {
      if (!remoteClaimed && !remoteClaimMayHaveCommitted) {
        await this.deps.cancelHandoff?.(projectId, sessionId).catch(() => {});
      }
      throw error;
    }
  }

  /** Poll every linked authority outbox. Coalesced for timer/focus/resume. */
  syncMailboxesInBackground(): void {
    if (this.mailboxSyncRunning) return;
    this.mailboxSyncRunning = true;
    void this.syncMailboxes()
      .catch((cause) => {
        console.warn(
          "[desktop] session mailbox sync failed:",
          cause instanceof Error ? cause.message : cause,
        );
      })
      .finally(() => {
        this.mailboxSyncRunning = false;
      });
  }

  /** Persist a desired transcript watermark, then opportunistically drain. */
  mirrorInBackground(projectId: string, sessionId: string): void {
    if (this.diverged.has(sessionId) || this.inflight.has(sessionId)) return;
    // Incognito sessions never leave this machine (ADR 0062).
    if (this.deps.isIncognito(sessionId)) return;
    const link = this.linkFor(projectId);
    if (!link) return;
    const sync = this.deps.getSessionSync?.();
    if (sync && this.deps.identity) {
      void sync
        .enqueue({
          identity: this.deps.identity,
          projectId,
          sessionId,
          destinationKey: destinationKey(link),
        })
        .then(() => this.drainMirrorsInBackground())
        .catch((cause) => {
          console.warn(
            `[desktop] could not enqueue session mirror ${sessionId}:`,
            cause instanceof Error ? cause.message : cause,
          );
        });
      return;
    }
    this.inflight.add(sessionId);
    void this.push({ link, sessionId })
      .catch((cause) => {
        // Offline / server down: the next settled turn resends from the
        // remote's watermark, so nothing is lost by staying quiet here.
        console.warn(
          `[desktop] session mirror failed for ${sessionId}:`,
          cause instanceof Error ? cause.message : cause,
        );
      })
      .finally(() => this.inflight.delete(sessionId));
  }

  /** Heartbeat every mirrored active session and retry all durable intents. */
  syncMirrorsInBackground(): void {
    if (this.syncDrainRunning) return;
    this.syncDrainRunning = true;
    void this.enqueueHeartbeats()
      .then(() => this.drainMirrors())
      .catch((cause) => {
        console.warn(
          "[desktop] durable session sync failed:",
          cause instanceof Error ? cause.message : cause,
        );
      })
      .finally(() => {
        this.syncDrainRunning = false;
      });
  }

  private drainMirrorsInBackground(): void {
    if (this.syncDrainRunning) return;
    this.syncDrainRunning = true;
    void this.drainMirrors().finally(() => {
      this.syncDrainRunning = false;
    });
  }

  private async enqueueHeartbeats(): Promise<void> {
    const sync = this.deps.getSessionSync?.();
    if (!sync || !this.deps.identity || !this.deps.listSessions) return;
    for (const link of this.links()) {
      const sessions = await this.deps.listSessions(link.localProjectId);
      for (const session of sessions) {
        if (
          session.status !== "active" ||
          session.authorityHostId !== this.deps.hostId ||
          this.diverged.has(session.id) ||
          this.deps.isIncognito(session.id)
        ) {
          continue;
        }
        await sync.enqueue({
          identity: this.deps.identity,
          projectId: link.localProjectId,
          sessionId: session.id,
          destinationKey: destinationKey(link),
        });
      }
    }
  }

  private async drainMirrors(): Promise<void> {
    const sync = this.deps.getSessionSync?.();
    if (!sync) return;
    while (true) {
      const intents = await sync.claimDue({
        workerId: this.syncWorkerId,
        limit: 10,
        leaseMs: 60_000,
      });
      if (intents.length === 0) return;
      for (const intent of intents) {
        const link = this.linkFor(intent.projectId);
        try {
          if (!link || destinationKey(link) !== intent.destinationKey) {
            throw new Error("The linked server changed");
          }
          const result = await this.push({
            link,
            sessionId: intent.sessionId,
            targetSequence: intent.sequence,
          });
          if (result === "diverged") {
            await sync.markDiverged({
              intentId: intent.id,
              workerId: this.syncWorkerId,
              error: "The remote session owns a newer fork",
            });
            continue;
          }
          await sync.acknowledge({
            intentId: intent.id,
            workerId: this.syncWorkerId,
            authorityRevision: result.authorityRevision,
            // The remote reached at least the intent's watermark; the
            // receipt names exactly the one the intent asked for.
            sequence: intent.sequence,
          });
        } catch (cause) {
          await sync
            .fail({
              intentId: intent.id,
              workerId: this.syncWorkerId,
              error: cause instanceof Error ? cause.message : String(cause),
              retryAt: new Date(
                Date.now() +
                  Math.min(300_000, 1_000 * 2 ** intent.attemptCount),
              ),
            })
            .catch(() => {});
        }
      }
    }
  }

  /**
   * Push the log after the remote's sequence until the remote reaches
   * `targetSequence` (default: the local snapshot's sequence).
   */
  private async push({
    link,
    sessionId,
    targetSequence,
  }: {
    link: MirrorLink;
    sessionId: string;
    targetSequence?: number;
  }): Promise<"diverged" | { authorityRevision: number; sequence: number }> {
    const detail = await this.deps.sessionDetail(
      link.localProjectId,
      sessionId,
    );
    // Backstop for the privacy guarantee: a chat FORKED from an incognito
    // one inherits its privacy even if the fork's own marking was missed.
    // Enforced here, at the only place that can leak (ADR 0062).
    if (
      detail.parentSessionId &&
      this.deps.isIncognito(detail.parentSessionId)
    ) {
      this.deps.markIncognito(sessionId);
      throw new Error("Incognito sessions are not mirrored");
    }
    // A project agent's slug survives the trip: the same committed
    // definition exists on the server, so the fork can run the SAME agent.
    // Core owns the id convention; parsing it by hand here would drift.
    const projectAgent = detail.agentId
      ? parseProjectAgentId(detail.agentId)
      : undefined;
    const target = targetSequence ?? detail.snapshot.sequence;
    const watermarkKey = `${destinationKey(link)}|${sessionId}`;
    let after = await this.remoteWatermark({ link, sessionId, watermarkKey });
    for (let round = 0; round < MAX_PUSH_ROUNDS; round += 1) {
      const exported = await this.deps.exportMirror({
        projectId: link.localProjectId,
        sessionId,
        after,
      });
      const body: SessionMirrorInput = {
        authority: {
          hostId: detail.authorityHostId,
          revision: detail.authorityRevision,
        },
        title: detail.title,
        icon: detail.icon,
        source: detail.source,
        todos: detail.todos,
        workStatus: detail.workStatus,
        ...(projectAgent ? { agentSlug: projectAgent.slug } : {}),
        ...(exported.base ? { base: exported.base } : {}),
        events: exported.events,
        ...(exported.projectEvents
          ? { projectEvents: exported.projectEvents }
          : {}),
      };
      const response = await this.remoteRequest(link, {
        url: `${link.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(
          link.remoteProjectId,
        )}/agent/sessions/${encodeURIComponent(sessionId)}/mirror`,
        method: "PUT",
        body: JSON.stringify(body),
      });
      if (response.status === 409) {
        const conflict = mirrorConflictSchema.safeParse(
          await response.json().catch(() => null),
        );
        if (conflict.success && conflict.data.code === "diverged") {
          this.diverged.add(sessionId);
          // Stamp the local copy so every client shows "continued on the
          // server" and treats this transcript as history (ADR 0062).
          await this.deps
            .markFork(link.localProjectId, sessionId, {
              serverUrl: link.serverUrl,
              remoteProjectId: link.remoteProjectId,
            })
            .catch((cause) => {
              console.warn(
                `[desktop] fork marker failed for ${sessionId}:`,
                cause,
              );
            });
          console.warn(
            `[desktop] session ${sessionId} was continued on the server; mirroring stopped (it owns the fork now).`,
          );
          return "diverged";
        }
        if (conflict.success && conflict.data.code === "behind") {
          // The remote's copy ends elsewhere: resend from there, or send a
          // base when it has nothing.
          this.remoteSequences.set(watermarkKey, conflict.data.sequence);
          after = conflict.data.sequence > 0 ? conflict.data.sequence : null;
          continue;
        }
        throw new Error("A turn is running on the linked server");
      }
      if (!response.ok) {
        throw new Error(`mirror ${response.status}`);
      }
      const mirrored = mirrorAcceptedSchema.safeParse(
        await response.json().catch(() => null),
      );
      if (!mirrored.success) {
        throw new Error("The linked server answered the mirror unexpectedly");
      }
      const { session: remote, sequence } = mirrored.data;
      if (remote.authorityRevision !== detail.authorityRevision) {
        throw new Error(
          "The linked server did not acknowledge this authority revision",
        );
      }
      this.remoteSequences.set(watermarkKey, sequence);
      if (sequence >= target) {
        return { authorityRevision: remote.authorityRevision, sequence };
      }
      // The export was bounded or the log moved on: continue from the
      // remote's new watermark.
      after = sequence > 0 ? sequence : null;
    }
    throw new Error(
      `The linked server did not reach event ${target} of session ${sessionId} after ${MAX_PUSH_ROUNDS} pushes`,
    );
  }

  /**
   * Where the remote copy ends, as far as this desktop knows: learned from
   * its answers in this process, else the durable sync receipt, else
   * nothing (a base goes; a 409 `behind` corrects any stale guess).
   */
  private async remoteWatermark({
    link,
    sessionId,
    watermarkKey,
  }: {
    link: MirrorLink;
    sessionId: string;
    watermarkKey: string;
  }): Promise<number | null> {
    const known = this.remoteSequences.get(watermarkKey);
    if (known !== undefined) return known > 0 ? known : null;
    const sync = this.deps.getSessionSync?.();
    if (!sync || !this.deps.identity) return null;
    const status = await sync.status({
      identity: this.deps.identity,
      projectId: link.localProjectId,
      sessionId,
      destinationKey: destinationKey(link),
    });
    const acknowledged = status?.acknowledgedSequence ?? null;
    return acknowledged !== null && acknowledged > 0 ? acknowledged : null;
  }

  private async syncMailboxes(): Promise<void> {
    for (const profile of this.deps.profiles.list().profiles) {
      const remoteProjects = this.deps.profileConfig.forProfile(
        profile.id,
      ).remoteProjects;
      for (const [localProjectId, link] of Object.entries(
        remoteProjects.list(),
      )) {
        const response = await this.mailboxRequest({
          remoteProjects,
          localProjectId,
          url: `${link.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(
            link.remoteProjectId,
          )}/session-mailboxes?destinationHostId=${encodeURIComponent(
            this.deps.hostId,
          )}`,
          method: "GET",
        });
        if (!response.ok) {
          if (response.status === 404 || response.status === 503) continue;
          throw new Error(`mailbox list ${response.status}`);
        }
        const body = (await response.json()) as { items: SessionMailboxItem[] };
        for (const item of body.items) {
          if (this.deps.isIncognito(item.sessionId)) continue;
          await this.deps.importMailbox(localProjectId, item);
          const acknowledged = await this.mailboxRequest({
            remoteProjects,
            localProjectId,
            url: `${link.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(
              link.remoteProjectId,
            )}/session-mailboxes/${encodeURIComponent(item.id)}/acknowledge`,
            method: "POST",
            body: JSON.stringify({ destinationHostId: this.deps.hostId }),
          });
          if (!acknowledged.ok && acknowledged.status !== 404) {
            throw new Error(`mailbox acknowledge ${acknowledged.status}`);
          }
        }
      }
    }
  }

  private async mailboxRequest(input: {
    remoteProjects: RemoteProjectsStore;
    localProjectId: string;
    url: string;
    method: "GET" | "POST";
    body?: string;
  }): Promise<Response> {
    const request = async (forceRefresh = false) => {
      const accessToken = await input.remoteProjects.accessToken(
        input.localProjectId,
        {
          ...(forceRefresh ? { forceRefresh } : {}),
          refresh: (credentials) => refreshRemoteCredentials({ credentials }),
        },
      );
      return fetch(input.url, {
        method: input.method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(input.body ? { "content-type": "application/json" } : {}),
        },
        ...(input.body ? { body: input.body } : {}),
      });
    };
    let response = await request();
    if (response.status === 401) response = await request(true);
    return response;
  }

  private async remoteRequest(
    link: MirrorLink,
    input: { url: string; method: "GET" | "POST" | "PUT"; body?: string },
  ): Promise<Response> {
    const request = async (forceRefresh = false) => {
      const accessToken = await link.remoteProjects.accessToken(
        link.localProjectId,
        {
          ...(forceRefresh ? { forceRefresh } : {}),
          refresh: (credentials) => refreshRemoteCredentials({ credentials }),
        },
      );
      return fetch(input.url, {
        method: input.method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(input.body ? { "content-type": "application/json" } : {}),
        },
        ...(input.body ? { body: input.body } : {}),
      });
    };
    let response = await request();
    if (response.status === 401) response = await request(true);
    return response;
  }

  private async remoteSession(
    link: MirrorLink,
    sessionId: string,
  ): Promise<RemoteSessionView> {
    const response = await this.remoteRequest(link, {
      url: `${link.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(
        link.remoteProjectId,
      )}/agent/sessions/${encodeURIComponent(sessionId)}`,
      method: "GET",
    });
    if (!response.ok) {
      throw new Error(
        `The server session could not be read (${response.status})`,
      );
    }
    const remote = parseRemoteSession(await response.json().catch(() => null));
    if (!remote) throw new Error("The server session could not be read");
    return remote;
  }

  private async finishMove(
    projectId: string,
    sessionId: string,
    link: MirrorLink,
    remote: RemoteSessionView,
  ): Promise<{ ok: true; serverUrl: string; remoteProjectId: string }> {
    const completeHandoff = this.deps.completeHandoff;
    if (!completeHandoff)
      throw new Error("Durable session handoff is unavailable");
    await completeHandoff(
      projectId,
      sessionId,
      remote.authorityHostId,
      remote.authorityRevision,
    );
    this.diverged.add(sessionId);
    await this.deps
      .markFork(projectId, sessionId, {
        serverUrl: link.serverUrl,
        remoteProjectId: link.remoteProjectId,
      })
      .catch((cause) => {
        console.warn(`[desktop] fork marker failed for ${sessionId}:`, cause);
      });
    return {
      ok: true,
      serverUrl: link.serverUrl,
      remoteProjectId: link.remoteProjectId,
    };
  }

  /** The first profile link for this LOCAL project (tokens are per person;
   * the desktop is single-user, so the first hit is the user's). */
  private linkFor(projectId: string): MirrorLink | null {
    for (const profile of this.deps.profiles.list().profiles) {
      const link = this.deps.profileConfig
        .forProfile(profile.id)
        .remoteProjects.get(projectId);
      if (link) {
        const remoteProjects = this.deps.profileConfig.forProfile(
          profile.id,
        ).remoteProjects;
        return {
          serverUrl: link.serverUrl,
          remoteProjectId: link.remoteProjectId,
          remoteProjects,
          localProjectId: projectId,
        };
      }
    }
    return null;
  }

  private *links(): Iterable<MirrorLink> {
    const seen = new Set<string>();
    for (const profile of this.deps.profiles.list().profiles) {
      const remoteProjects = this.deps.profileConfig.forProfile(
        profile.id,
      ).remoteProjects;
      for (const [localProjectId, link] of Object.entries(
        remoteProjects.list(),
      )) {
        if (seen.has(localProjectId)) continue;
        seen.add(localProjectId);
        yield {
          serverUrl: link.serverUrl,
          remoteProjectId: link.remoteProjectId,
          remoteProjects,
          localProjectId,
        };
      }
    }
  }
}

interface MirrorLink {
  serverUrl: string;
  remoteProjectId: string;
  remoteProjects: RemoteProjectsStore;
  localProjectId: string;
}

function destinationKey(link: MirrorLink): string {
  return `${link.serverUrl.replace(/\/+$/, "")}|${link.remoteProjectId}`;
}

// The remote's answers are parsed defensively: the mirror talks to the
// route with raw fetch, and the route's generated types may lag the server.

/** The fields of a remote AgentSession this mirror reads. */
const remoteSessionSchema = z.object({
  authorityHostId: z.string(),
  authorityRevision: z.number(),
  mirrorSequence: z.number(),
});

type RemoteSessionView = z.infer<typeof remoteSessionSchema>;

/** `200` from the mirror route: the remote session and its new watermark. */
const mirrorAcceptedSchema = z.object({
  session: remoteSessionSchema,
  sequence: z.number().int().nonnegative(),
});

/** `409` from the mirror route. */
const mirrorConflictSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("diverged") }),
  z.object({
    code: z.literal("behind"),
    sequence: z.number().int().nonnegative(),
  }),
]);

function parseRemoteSession(value: unknown): RemoteSessionView | null {
  const parsed = remoteSessionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function remoteAuthorityOwnsSnapshot(args: {
  remote: RemoteSessionView;
  sourceHostId: string;
  sourceRevision: number;
  desiredSequence: number;
}): boolean {
  return (
    args.remote.authorityHostId !== args.sourceHostId &&
    args.remote.authorityRevision > args.sourceRevision &&
    args.remote.mirrorSequence >= args.desiredSequence
  );
}
