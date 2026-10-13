import type { Item, Turn } from "@catamorphic/agent-protocol";
import type { AgentSignIn } from "../agent-credentials.js";

/** A chat whose latest turn failed on its agent's sign-in. */
export interface SignInFailure {
  projectId: string;
  sessionId: string;
  turnId: string;
  /** The chat's agent. */
  agentId: string;
}

/** An agent's sign-in as this machine holds it now. */
export interface SignInRead {
  /** Changes whenever the credentials do: a sign-in, a token refresh. */
  fingerprint: string;
  /** It can run a turn. */
  usable: boolean;
  /** Its access token is good for a while: a new CLI uses it as it is. */
  fresh: boolean;
}

export interface SignInRecoveryDeps {
  /** The roster agent whose credentials a chat's agent uses (an assistant's agent). */
  credentialAgentId(agentId: string): string;
  /** The harness sign-in an agent runs on, when this machine holds it. */
  signInFor(agentId: string): AgentSignIn | undefined;
  /** That sign-in now. */
  readSignIn(signIn: AgentSignIn): Promise<SignInRead>;
  /** Whether the failed turn may still run again by itself ({@link mayRunAgain}). */
  mayRunAgain(failure: SignInFailure): Promise<boolean>;
  /**
   * Run the failed turn again, as the person's Retry does, only while it
   * is still its chat's latest turn.
   */
  retry(failure: SignInFailure): Promise<void>;
}

interface Tracked extends SignInFailure {
  credentialAgentId: string;
  signIn: AgentSignIn | undefined;
  /** The sign-in when the failure was seen; a change from it is the cue. */
  baseline: Promise<string | undefined>;
  /**
   * Seen as its turn settled here. Another Claude Code may have refreshed
   * the sign-in between the failed attempt and that look, so a fresh
   * access token is a cue too. A failure a chat shows from before waits
   * for a change, so opening an old chat does not run it.
   */
  settledHere: boolean;
  since: number;
}

/** How often a failed chat's sign-in is looked at, and for how long. */
const POLL_MS = 5_000;
const POLL_FOR_MS = 10 * 60_000;
/** After this, a failure is forgotten until its chat shows it again. */
const FORGET_AFTER_MS = 30 * 60_000;
/** Runs one turn gets from sign-in changes, so nothing flaps forever. */
const MAX_RETRIES_PER_TURN = 3;
/** How long a turn's runs are counted, unless its chat moves on first. */
const RETRIES_KEPT_MS = 24 * 60 * 60_000;

/**
 * Whether a chat's failed turn may run again by itself (ADR 0228): it is
 * still the chat's latest and failed on its sign-in; the chat is a
 * top-level one the person keeps (active, not archived, not a subsession,
 * not continued on a server); and the turn ran the person's own message,
 * not a workflow's, an automation's or another agent's.
 */
export function mayRunAgain(input: {
  turnId: string;
  session: {
    status: string;
    visibility: string;
    archivedAt: string | null;
    parentSessionId: string | null;
  };
  /** The chat's turns in order. */
  turns: readonly Turn[];
  items: readonly Item[];
}): boolean {
  const { session } = input;
  const latest = input.turns.at(-1);
  if (
    latest?.id !== input.turnId ||
    latest.status !== "failed" ||
    latest.error?.kind !== "auth"
  )
    return false;
  if (
    session.status !== "active" ||
    session.visibility !== "promoted" ||
    session.archivedAt !== null ||
    session.parentSessionId !== null
  )
    return false;
  if (
    input.items.some(
      (item) => item.kind === "notice" && item.code === "mirror_fork",
    )
  )
    return false;
  const opened = input.items.find((item) => item.id === latest.inputItemId);
  return opened?.kind === "user_message";
}

/**
 * Keeps the auth card's promise (ADR 0228): a chat whose latest turn failed
 * on its agent's sign-in runs that turn again once the sign-in works,
 * however it came back. Work's own re-login and a changed key say so
 * directly; a sign-in renewed outside Work (`/login` in a terminal,
 * another Claude Code refreshing the shared login) shows as a change in
 * the credentials, looked at every few seconds for a while after the
 * failure and whenever a window gains focus or the machine wakes, until
 * the failure is forgotten. Each change runs a failed turn once, three
 * times at most; a turn that fails again waits for the next change. It
 * works for chats that are not on screen, and for one shown after a
 * restart once its chat reports the failure.
 */
export class SignInRecovery {
  /** The failure each chat shows, by session. */
  private readonly failures = new Map<string, Tracked>();
  /** How often each turn ran again here, and when it last did. */
  private readonly retries = new Map<
    string,
    { sessionId: string; count: number; at: number }
  >();
  private timer: ReturnType<typeof setInterval> | undefined;
  private probing: Promise<void> | undefined;

  constructor(
    private readonly deps: SignInRecoveryDeps,
    private readonly now: () => number = Date.now,
  ) {}

  /** A chat shows a turn that failed on its agent's sign-in. */
  failed(failure: SignInFailure): void {
    this.track(failure, false);
  }

  /** A turn settled: a sign-in failure is tracked, anything else ends one. */
  settled(event: {
    projectId: string;
    sessionId: string;
    turnId?: string;
    status: string;
    errorKind?: string;
    agentId: string | null;
    retrying?: boolean;
  }): void {
    if (!event.turnId || event.retrying) return;
    // The chat moved on: its earlier turns' runs no longer count.
    for (const [turnId, retried] of this.retries)
      if (retried.sessionId === event.sessionId && turnId !== event.turnId)
        this.retries.delete(turnId);
    if (
      event.status === "failed" &&
      event.errorKind === "auth" &&
      event.agentId
    ) {
      this.track(
        {
          projectId: event.projectId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          agentId: event.agentId,
        },
        true,
      );
      return;
    }
    if (event.status === "completed") this.retries.delete(event.turnId);
    this.failures.delete(event.sessionId);
    this.schedule();
  }

  /**
   * The agent's sign-in works again by Work's own hand (a finished
   * re-login, a key changed in Settings): its failed turns run again, even
   * ones that ran as often as a change may run them.
   */
  async signedIn(agentId: string): Promise<void> {
    const credentialAgentId = this.deps.credentialAgentId(agentId);
    await Promise.all(
      [...this.failures.values()]
        .filter((failure) => failure.credentialAgentId === credentialAgentId)
        .map((failure) => this.recover(failure, { asked: true })),
    );
  }

  /** Look at every failed chat's sign-in now (focus, wake, the poll). */
  probe(): Promise<void> {
    this.probing ??= this.check().finally(() => {
      this.probing = undefined;
    });
    return this.probing;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.failures.clear();
    this.retries.clear();
  }

  private track(failure: SignInFailure, settledHere: boolean): void {
    const tracked = this.failures.get(failure.sessionId);
    if (tracked?.turnId === failure.turnId) {
      // The first sight's baseline stands; its settling here counts
      // however the chat reported it first.
      if (settledHere) tracked.settledHere = true;
      return;
    }
    const signIn = this.deps.signInFor(failure.agentId);
    // A turn that ran again as often as it may is not looked at: only
    // Work's own re-login or a changed key runs it now, or the person.
    const exhausted = this.exhausted(failure.turnId);
    this.failures.set(failure.sessionId, {
      ...failure,
      credentialAgentId: this.deps.credentialAgentId(failure.agentId),
      signIn,
      baseline:
        signIn && !exhausted
          ? this.deps.readSignIn(signIn).then(
              (read) => read.fingerprint,
              () => undefined,
            )
          : Promise.resolve(undefined),
      settledHere,
      since: this.now(),
    });
    this.schedule();
  }

  private exhausted(turnId: string): boolean {
    return (this.retries.get(turnId)?.count ?? 0) >= MAX_RETRIES_PER_TURN;
  }

  /** The failures whose sign-in is worth reading now. */
  private watched(): Tracked[] {
    return [...this.failures.values()].filter(
      (failure) => failure.signIn && !this.exhausted(failure.turnId),
    );
  }

  private async check(): Promise<void> {
    this.forgetOld();
    // One read per sign-in, however many chats wait on it.
    const bySignIn = new Map<
      string,
      { signIn: AgentSignIn; waiting: Tracked[] }
    >();
    for (const failure of this.watched()) {
      const signIn = failure.signIn;
      if (!signIn) continue;
      const key = `${signIn.harness}:${signIn.auth}:${signIn.auth === "local" ? "" : signIn.id}`;
      const group = bySignIn.get(key) ?? { signIn, waiting: [] };
      group.waiting.push(failure);
      bySignIn.set(key, group);
    }
    for (const { signIn, waiting } of bySignIn.values()) {
      const read = await this.deps.readSignIn(signIn).catch(() => undefined);
      if (!read?.usable) continue;
      for (const failure of waiting) {
        const cue =
          (failure.settledHere && read.fresh) ||
          (await failure.baseline) !== read.fingerprint;
        if (cue) await this.recover(failure, { asked: false });
      }
    }
    this.schedule();
  }

  private async recover(
    failure: Tracked,
    input: { asked: boolean },
  ): Promise<void> {
    if (this.failures.get(failure.sessionId) !== failure) return;
    const count = this.retries.get(failure.turnId)?.count ?? 0;
    if (!input.asked && count >= MAX_RETRIES_PER_TURN) return;
    this.failures.delete(failure.sessionId);
    if (!(await this.deps.mayRunAgain(failure).catch(() => false))) return;
    this.retries.set(failure.turnId, {
      sessionId: failure.sessionId,
      count: count + 1,
      at: this.now(),
    });
    await this.deps
      .retry(failure)
      .catch((error: unknown) =>
        console.warn(
          "[desktop] Could not run a turn again after its agent signed in:",
          error,
        ),
      );
    this.schedule();
  }

  /** Failures past their time, and runs counted long enough ago. */
  private forgetOld(): void {
    const now = this.now();
    for (const [sessionId, failure] of this.failures)
      if (now - failure.since >= FORGET_AFTER_MS)
        this.failures.delete(sessionId);
    for (const [turnId, retried] of this.retries)
      if (now - retried.at >= RETRIES_KEPT_MS) this.retries.delete(turnId);
  }

  /** Poll only while a failure is recent and its sign-in worth reading. */
  private schedule(): void {
    this.forgetOld();
    const now = this.now();
    const polling = this.watched().some(
      (failure) => now - failure.since < POLL_FOR_MS,
    );
    if (polling && !this.timer) {
      this.timer = setInterval(() => void this.probe(), POLL_MS);
      this.timer.unref?.();
    } else if (!polling && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
