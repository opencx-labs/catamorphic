import {
  type AgentSessionDetail,
  parseProjectAgentId,
  type SessionMailboxItem,
} from "@catamorphic/core";
import type { ProfileConfigManager } from "./profile-config.js";
import type { ProfilesStore } from "./profiles.js";
import { refreshRemoteCredentials } from "./remote-oauth.js";
import type { RemoteProjectsStore } from "./remote-projects-store.js";

/**
 * Session mirroring (ADR 0061): local-first, synced to the linked remote.
 * After every settled turn on a remote-linked project, the full transcript
 * is pushed (idempotently, by message id) to the remote's mirror route —
 * so a phone connected to the remote server sees the desktop's chats, and
 * when this desktop is asleep, CONTINUES them there (the remote re-anchors
 * its own assistant with the mirrored history).
 *
 * Fork rule: the first 409 `diverged` means someone continued the session
 * on the server — the server owns that conversation now, and this desktop
 * stops pushing it (remembered per session for the process lifetime;
 * a restart re-learns it from the same 409).
 */
export class RemoteSessionMirror {
  private readonly diverged = new Set<string>();
  private readonly inflight = new Set<string>();
  private mailboxSyncRunning = false;

  constructor(
    private readonly deps: {
      hostId: string;
      profiles: ProfilesStore;
      profileConfig: ProfileConfigManager;
      /** Desktop-local privacy flag (ADR 0062): skip these entirely. */
      isIncognito: (sessionId: string) => boolean;
      /** Record an inherited flag (a fork of an incognito chat). */
      markIncognito: (sessionId: string) => void;
      /** The session's full transcript, under the desktop identity. */
      sessionDetail: (
        projectId: string,
        sessionId: string,
      ) => Promise<AgentSessionDetail>;
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
  ) {}

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

  /** Fire-and-forget from the turn-settled hook; never throws. */
  mirrorInBackground(projectId: string, sessionId: string): void {
    if (this.diverged.has(sessionId) || this.inflight.has(sessionId)) return;
    // Incognito sessions never leave this machine (ADR 0062).
    if (this.deps.isIncognito(sessionId)) return;
    const link = this.linkFor(projectId);
    if (!link) return;
    this.inflight.add(sessionId);
    void this.push(link, sessionId)
      .catch((cause) => {
        // Offline / server down: the next settled turn retries with the
        // full transcript, so nothing is lost by staying quiet here.
        console.warn(
          `[desktop] session mirror failed for ${sessionId}:`,
          cause instanceof Error ? cause.message : cause,
        );
      })
      .finally(() => this.inflight.delete(sessionId));
  }

  private async push(link: MirrorLink, sessionId: string): Promise<void> {
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
      return;
    }
    // A project agent's slug survives the trip: the same committed
    // definition exists on the server, so the fork can run the SAME agent.
    // Core owns the id convention; parsing it by hand here would drift.
    const projectAgent = detail.agentId
      ? parseProjectAgentId(detail.agentId)
      : undefined;
    const request = async (forceRefresh = false) => {
      const accessToken = await link.remoteProjects.accessToken(
        link.localProjectId,
        {
          ...(forceRefresh ? { forceRefresh } : {}),
          refresh: (credentials) => refreshRemoteCredentials({ credentials }),
        },
      );
      return fetch(
        `${link.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(
          link.remoteProjectId,
        )}/agent/sessions/${encodeURIComponent(sessionId)}/mirror`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            authority: {
              hostId: detail.authorityHostId,
              revision: detail.authorityRevision,
            },
            title: detail.title,
            icon: detail.icon,
            provider: detail.provider,
            ...(projectAgent ? { agentSlug: projectAgent.slug } : {}),
            messages: detail.messages.map((message) => ({
              id: message.id,
              role: message.role,
              content: message.content,
              metadata: message.metadata,
              author: message.author,
              deliveryMode: message.deliveryMode,
              idempotencyKey: message.idempotencyKey,
              createdAt: new Date(message.createdAt).toISOString(),
            })),
          }),
        },
      );
    };
    let response = await request();
    if (response.status === 401) response = await request(true);
    if (response.status === 409) {
      const body = (await response.json().catch(() => ({}))) as {
        diverged?: boolean;
      };
      if (body.diverged) {
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
        return;
      }
      // A turn running server-side right now: retry on the next settle.
      return;
    }
    if (!response.ok) {
      throw new Error(`mirror ${response.status}`);
    }
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
}

interface MirrorLink {
  serverUrl: string;
  remoteProjectId: string;
  remoteProjects: RemoteProjectsStore;
  localProjectId: string;
}
