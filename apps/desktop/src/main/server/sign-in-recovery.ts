import type { AgentSignIn } from "../agent-credentials.js";

/** A chat whose latest turn failed on its agent's sign-in. */
export interface SignInFailure {
  projectId: string;
  sessionId: string;
  turnId: string;
  /** The chat's agent. */
  agentId: string;
}

export interface SignInRecoveryDeps {
  /** The roster agent whose credentials a chat's agent uses (an assistant's agent). */
  credentialAgentId(agentId: string): string;
  /** The harness sign-in an agent runs on, when this machine holds it. */
  signInFor(agentId: string): AgentSignIn | undefined;
  /** That sign-in now: what changes when it does, and whether it can run a turn. */
  readSignIn(
    signIn: AgentSignIn,
  ): Promise<{ fingerprint: string; usable: boolean }>;
  /** Whether the turn is still its chat's latest, failed on its sign-in. */
  stillFailed(failure: SignInFailure): Promise<boolean>;
  /** Run the failed turn again, as the person's Retry does. */
  retry(failure: SignInFailure): Promise<void>;
}

interface Tracked extends SignInFailure {
  credentialAgentId: string;
  signIn: AgentSignIn | undefined;
  /** The sign-in when the failure was seen; a change from it is the cue. */
  baseline: Promise<string | undefined>;
  since: number;
}

/** How often a failed chat's sign-in is looked at, and for how long. */
const POLL_MS = 5_000;
const POLL_FOR_MS = 10 * 60_000;
/** Retries one turn gets from sign-in changes, so nothing flaps forever. */
const MAX_RETRIES_PER_TURN = 3;

/**
 * Keeps the auth card's promise (ADR 0227): a chat whose latest turn failed
 * on its agent's sign-in runs that turn again once the sign-in works,
 * however it came back. Work's own re-login and a changed key say so
 * directly; a sign-in renewed outside Work (`/login` in a terminal,
 * another Claude Code refreshing the shared login) shows as a change in
 * the credentials, looked at every few seconds for a while after the
 * failure and whenever a window gains focus or the machine wakes. Each
 * change runs a failed turn once; a turn that fails again waits for the
 * next change. It works for chats that are not on screen, and for one
 * shown after a restart once its chat reports the failure.
 */
export class SignInRecovery {
  /** The failure each chat shows, by session. */
  private readonly failures = new Map<string, Tracked>();
  /** How often each turn ran again here. */
  private readonly retries = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private probing: Promise<void> | undefined;

  constructor(
    private readonly deps: SignInRecoveryDeps,
    private readonly now: () => number = Date.now,
  ) {}

  /** A chat's latest turn failed on its agent's sign-in. */
  failed(failure: SignInFailure): void {
    if (this.failures.get(failure.sessionId)?.turnId === failure.turnId) return;
    const signIn = this.deps.signInFor(failure.agentId);
    this.failures.set(failure.sessionId, {
      ...failure,
      credentialAgentId: this.deps.credentialAgentId(failure.agentId),
      signIn,
      baseline: signIn
        ? this.deps.readSignIn(signIn).then(
            (read) => read.fingerprint,
            () => undefined,
          )
        : Promise.resolve(undefined),
      since: this.now(),
    });
    this.schedule();
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
    if (
      event.status === "failed" &&
      event.errorKind === "auth" &&
      event.agentId
    ) {
      this.failed({
        projectId: event.projectId,
        sessionId: event.sessionId,
        turnId: event.turnId,
        agentId: event.agentId,
      });
      return;
    }
    if (event.status === "completed") this.retries.delete(event.turnId);
    this.failures.delete(event.sessionId);
    this.schedule();
  }

  /**
   * The agent's sign-in works again by Work's own hand (a finished
   * re-login, a key changed in Settings): its failed turns run again.
   */
  async signedIn(agentId: string): Promise<void> {
    const credentialAgentId = this.deps.credentialAgentId(agentId);
    await Promise.all(
      [...this.failures.values()]
        .filter((failure) => failure.credentialAgentId === credentialAgentId)
        .map((failure) => this.recover(failure)),
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
  }

  private async check(): Promise<void> {
    // One read per sign-in, however many chats wait on it.
    const bySignIn = new Map<
      string,
      { signIn: AgentSignIn; waiting: Tracked[] }
    >();
    for (const failure of this.failures.values()) {
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
        if ((await failure.baseline) === read.fingerprint) continue;
        await this.recover(failure);
      }
    }
    this.schedule();
  }

  private async recover(failure: Tracked): Promise<void> {
    if (this.failures.get(failure.sessionId) !== failure) return;
    this.failures.delete(failure.sessionId);
    const count = this.retries.get(failure.turnId) ?? 0;
    if (count >= MAX_RETRIES_PER_TURN) return;
    if (!(await this.deps.stillFailed(failure).catch(() => false))) return;
    this.retries.set(failure.turnId, count + 1);
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

  /** Poll only while a failure is recent and its sign-in can be read. */
  private schedule(): void {
    const now = this.now();
    const polling = [...this.failures.values()].some(
      (failure) => failure.signIn && now - failure.since < POLL_FOR_MS,
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
