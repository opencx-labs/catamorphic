import {
  type AgentSessionDetail,
  parseProjectAgentId,
} from "@catamorphic/core";
import type { ProfileConfigManager } from "./profile-config.js";
import type { ProfilesStore } from "./profiles.js";
import {
  type RemoteOAuthCredentials,
  refreshRemoteCredentials,
} from "./remote-oauth.js";

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

  constructor(
    private readonly deps: {
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
    },
  ) {}

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
      const expired =
        Date.parse(link.credentials.accessTokenExpiresAt) <=
        Date.now() + 60_000;
      if (forceRefresh || expired) {
        link.credentials = await refreshRemoteCredentials({
          credentials: link.credentials,
        });
        this.deps.profileConfig
          .forProfile(link.profileId)
          .remoteProjects.updateCredentials(
            link.localProjectId,
            link.credentials,
          );
      }
      return fetch(
        `${link.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(
          link.remoteProjectId,
        )}/agent/sessions/${encodeURIComponent(sessionId)}/mirror`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${link.credentials.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            title: detail.title,
            icon: detail.icon,
            provider: detail.provider,
            ...(projectAgent ? { agentSlug: projectAgent.slug } : {}),
            messages: detail.messages.map((message) => ({
              id: message.id,
              role: message.role,
              content: message.content,
              metadata: message.metadata,
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

  /** The first profile link for this LOCAL project (tokens are per person;
   * the desktop is single-user, so the first hit is the user's). */
  private linkFor(projectId: string): MirrorLink | null {
    for (const profile of this.deps.profiles.list().profiles) {
      const link = this.deps.profileConfig
        .forProfile(profile.id)
        .remoteProjects.get(projectId);
      if (link) {
        return {
          profileId: profile.id,
          serverUrl: link.serverUrl,
          remoteProjectId: link.remoteProjectId,
          credentials: link.credentials,
          localProjectId: projectId,
        };
      }
    }
    return null;
  }
}

interface MirrorLink {
  profileId: string;
  serverUrl: string;
  remoteProjectId: string;
  credentials: RemoteOAuthCredentials;
  localProjectId: string;
}
