import {
  isSettledTurnStatus,
  type SessionStreamMessage,
} from "@catamorphic/agent-protocol";

interface SessionRef {
  projectId: string;
  sessionId: string;
}

/** What following reaches: core's session stream and delivery. */
export interface SessionNotesAccess {
  /** The session's latest event sequence: following starts after it. */
  sequence(ref: SessionRef): Promise<number>;
  subscribe(
    ref: SessionRef,
    input: {
      after: number;
      send: (message: SessionStreamMessage) => boolean;
      onClose: (reason: "slow" | "ended") => void;
    },
  ): Promise<() => void>;
  /** A system message for the follower's agent, shown as one quiet line. */
  deliver(
    follower: SessionRef,
    input: { content: string; notice: string; idempotencyKey: string },
  ): Promise<unknown>;
}

/** Notes written close together go as one message. */
const BATCH_MS = 3_000;
/** At most one message to a follower about a session this often. */
const MIN_GAP_MS = 15_000;
const MAX_FOLLOWED = 20;

interface Follow {
  follower: SessionRef;
  followed: SessionRef;
  title: string;
  /**
   * The followed session's turns end with a result the follower would not
   * otherwise hear: it is not the follower's own delegated session.
   */
  reportsResults: boolean;
  stop: () => void;
  /** Notes not yet passed on, in order. */
  pending: { id: string; text: string }[];
  /** The latest message: a note once more work follows it. */
  latest: { id: string; text: string } | undefined;
  /** Notes already seen, by item id. */
  seen: Set<string>;
  timer: ReturnType<typeof setTimeout> | undefined;
  lastDelivered: number;
}

/**
 * Sessions following others' progress (ADR 0216). What a followed session
 * writes along the way reaches the follower a few notes at a time as one
 * system message, which its agent can pass on in its own words; the
 * person sees one quiet line. A note is an assistant message more work
 * follows in the same turn. A turn's last message is its result: a
 * session the follower delegated delivers it itself, so its turn's end
 * drops what has not been passed on; any other followed session's end
 * passes on what is left and the result at once.
 */
export class SessionNotes {
  private readonly follows = new Map<string, Follow>();

  constructor(private readonly access: SessionNotesAccess) {}

  /** Whether the session is followed, and by which session. */
  followerOf(followedSessionId: string): SessionRef | undefined {
    return this.follows.get(followedSessionId)?.follower;
  }

  async follow(input: {
    follower: SessionRef;
    followed: SessionRef;
    title: string;
    /** False for a session the follower started: delegation reports it. */
    reportsResults: boolean;
  }): Promise<void> {
    const key = input.followed.sessionId;
    if (key === input.follower.sessionId) return;
    this.unfollow(key);
    if (this.follows.size >= MAX_FOLLOWED) {
      const [oldest] = this.follows.keys();
      if (oldest) this.unfollow(oldest);
    }
    const follow: Follow = {
      ...input,
      stop: () => {},
      pending: [],
      latest: undefined,
      seen: new Set(),
      timer: undefined,
      lastDelivered: 0,
    };
    this.follows.set(key, follow);
    try {
      const after = await this.access.sequence(input.followed);
      const stop = await this.access.subscribe(input.followed, {
        after,
        send: (message) => {
          this.receive(follow, message);
          return true;
        },
        onClose: () => {
          if (this.follows.get(key) === follow) this.unfollow(key);
        },
      });
      if (this.follows.get(key) === follow) follow.stop = stop;
      else stop();
    } catch (cause) {
      if (this.follows.get(key) === follow) this.follows.delete(key);
      throw cause;
    }
  }

  unfollow(followedSessionId: string): void {
    const follow = this.follows.get(followedSessionId);
    if (!follow) return;
    this.follows.delete(followedSessionId);
    clearTimeout(follow.timer);
    follow.stop();
  }

  dispose(): void {
    for (const key of [...this.follows.keys()]) this.unfollow(key);
  }

  private receive(follow: Follow, message: SessionStreamMessage): void {
    if (message.type !== "events") return;
    for (const { event } of message.events) {
      if (
        event.type === "turn.changed" &&
        isSettledTurnStatus(event.turn.status)
      ) {
        const result = follow.latest;
        clearTimeout(follow.timer);
        follow.timer = undefined;
        follow.latest = undefined;
        if (follow.reportsResults && (result || follow.pending.length > 0))
          void this.pass(follow, result);
        else follow.pending = [];
        continue;
      }
      if (event.type !== "item.added" && event.type !== "item.changed")
        continue;
      const { item } = event;
      if (
        event.type === "item.added" &&
        follow.latest &&
        item.id !== follow.latest.id
      ) {
        follow.pending.push(follow.latest);
        follow.latest = undefined;
        this.schedule(follow);
      }
      if (
        item.kind !== "assistant_message" ||
        item.status !== "completed" ||
        follow.seen.has(item.id)
      )
        continue;
      follow.seen.add(item.id);
      const text = item.text.trim();
      if (text) follow.latest = { id: item.id, text };
    }
  }

  private schedule(follow: Follow): void {
    if (follow.timer) return;
    const at = Math.max(
      Date.now() + BATCH_MS,
      follow.lastDelivered + MIN_GAP_MS,
    );
    follow.timer = setTimeout(() => {
      follow.timer = undefined;
      void this.pass(follow);
    }, at - Date.now());
    follow.timer.unref?.();
  }

  /** Passes on the pending notes, and a finished turn's result if given. */
  private async pass(
    follow: Follow,
    result?: { id: string; text: string },
  ): Promise<void> {
    const notes = follow.pending.splice(0);
    const last = result ?? notes.at(-1);
    if (!last) return;
    follow.lastDelivered = Date.now();
    const lines = notes.map((note) => `- ${note.text}`).join("\n");
    const content = result
      ? `${follow.title} finished${lines ? `. Along the way:\n${lines}\n\nIts answer:` : ":"}\n${result.text}`
      : `${follow.title}, while it works:\n${lines}`;
    const notice = result
      ? `${follow.title}: finished`
      : `${follow.title}: ${notes.length === 1 ? "an update" : `${notes.length} updates`}`;
    await this.access
      .deliver(follow.follower, {
        content,
        notice,
        idempotencyKey: `notes:${follow.followed.sessionId}:${last.id}`,
      })
      .catch((cause: unknown) => {
        // A follower that can take no message (closed, gone) follows no more.
        console.warn("[notes] passing notes on failed:", cause);
        if (this.follows.get(follow.followed.sessionId) === follow)
          this.unfollow(follow.followed.sessionId);
      });
  }
}
