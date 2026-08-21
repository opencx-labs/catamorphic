import type { AgentSessionDetail } from "@catamorphic/core";
import type { ProfileConfigManager } from "./profile-config.js";
import type { ProfilesStore } from "./profiles.js";

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
      /** The session's full transcript, under the desktop identity. */
      sessionDetail: (
        projectId: string,
        sessionId: string,
      ) => Promise<AgentSessionDetail>;
    },
  ) {}

  /** Fire-and-forget from the turn-settled hook; never throws. */
  mirrorInBackground(projectId: string, sessionId: string): void {
    if (this.diverged.has(sessionId) || this.inflight.has(sessionId)) return;
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
    const response = await fetch(
      `${link.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(
        link.remoteProjectId,
      )}/agent/sessions/${encodeURIComponent(sessionId)}/mirror`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${link.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: detail.title,
          icon: detail.icon,
          provider: detail.provider,
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
    if (response.status === 409) {
      const body = (await response.json().catch(() => ({}))) as {
        diverged?: boolean;
      };
      if (body.diverged) {
        this.diverged.add(sessionId);
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
      if (link?.token) {
        return {
          serverUrl: link.serverUrl,
          remoteProjectId: link.remoteProjectId,
          token: link.token,
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
  token: string;
  localProjectId: string;
}
