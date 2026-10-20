import type { Item, Turn } from "@catamorphic/agent-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSignIn } from "../agent-credentials.js";
import {
  mayRunAgain,
  type SignInFailure,
  SignInRecovery,
  type SignInRecoveryDeps,
} from "./sign-in-recovery.js";

const claude: AgentSignIn = { harness: "claude-code", auth: "local", id: "c" };

function harness() {
  const signIn = { fingerprint: "keychain:1", usable: true, fresh: false };
  const retried: SignInFailure[] = [];
  const failedTurns = new Set<string>();
  let reads = 0;
  let clock = 0;
  const deps: SignInRecoveryDeps = {
    credentialAgentId: (agentId) => agentId.replace(/^assistant:/, ""),
    signInFor: (agentId) =>
      agentId === "router" ? undefined : { ...claude, id: agentId },
    readSignIn: async () => {
      reads += 1;
      return { ...signIn };
    },
    mayRunAgain: async (failure) => failedTurns.has(failure.turnId),
    retry: async (failure) => {
      retried.push(failure);
      failedTurns.delete(failure.turnId);
    },
  };
  const recovery = new SignInRecovery(deps, () => clock);
  const fail = (turnId: string, sessionId = "s1", agentId = "c") => {
    failedTurns.add(turnId);
    recovery.settled({
      projectId: "p",
      sessionId,
      turnId,
      status: "failed",
      errorKind: "auth",
      agentId,
    });
  };
  /** A chat shows a failure from before (after a restart, say). */
  const shown = (turnId: string, sessionId = "s1") => {
    failedTurns.add(turnId);
    recovery.failed({ projectId: "p", sessionId, turnId, agentId: "c" });
  };
  return {
    recovery,
    signIn,
    retried,
    failedTurns,
    fail,
    shown,
    reads: () => reads,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

let disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers) dispose();
  disposers = [];
  vi.useRealTimers();
});

function tracked() {
  const made = harness();
  disposers.push(() => made.recovery.dispose());
  return made;
}

describe("SignInRecovery (ADR 0228)", () => {
  it("runs a failed turn again exactly once when its sign-in changes to a usable one", async () => {
    const { recovery, signIn, retried, fail } = tracked();
    fail("t1");
    // Nothing changed yet: nothing runs.
    await recovery.probe();
    expect(retried).toEqual([]);
    // Another Claude Code refreshed the shared login.
    signIn.fingerprint = "keychain:2";
    await recovery.probe();
    await recovery.probe();
    expect(retried.map((failure) => failure.turnId)).toEqual(["t1"]);
  });

  it("runs a turn that just failed when its sign-in was refreshed before the failure was seen", async () => {
    const { recovery, signIn, retried, fail } = tracked();
    // Another Claude Code refreshed the login between the failed attempt
    // and the turn settling: the baseline already has the new token.
    signIn.fingerprint = "keychain:2";
    signIn.fresh = true;
    fail("t1");
    await recovery.probe();
    expect(retried.map((failure) => failure.turnId)).toEqual(["t1"]);
  });

  it("does not run a failure a chat shows from before just because its sign-in is fresh", async () => {
    const { recovery, signIn, retried, shown } = tracked();
    signIn.fresh = true;
    shown("t1");
    await recovery.probe();
    expect(retried).toEqual([]);
    signIn.fingerprint = "keychain:2";
    await recovery.probe();
    expect(retried).toHaveLength(1);
  });

  it("counts a failure's settling even when its chat reported it first", async () => {
    const { recovery, signIn, retried, fail, shown } = tracked();
    signIn.fresh = true;
    shown("t1");
    fail("t1");
    await recovery.probe();
    expect(retried).toHaveLength(1);
  });

  it("waits while the changed sign-in still cannot run a turn", async () => {
    const { recovery, signIn, retried, fail } = tracked();
    fail("t1");
    signIn.fingerprint = "keychain:2";
    signIn.usable = false;
    signIn.fresh = true;
    await recovery.probe();
    expect(retried).toEqual([]);
    signIn.usable = true;
    await recovery.probe();
    expect(retried).toHaveLength(1);
  });

  it("runs the turn again when Work's own re-login finishes, for the assistant's agent too", async () => {
    const { recovery, retried, fail } = tracked();
    fail("t1", "s1", "router");
    fail("t2", "s2", "assistant:c");
    await recovery.signedIn("router");
    await recovery.signedIn("c");
    expect(retried.map((failure) => failure.turnId)).toEqual(["t1", "t2"]);
  });

  it("forgets a failure once a later turn of its chat settles", async () => {
    const { recovery, signIn, retried, fail } = tracked();
    fail("t1");
    recovery.settled({
      projectId: "p",
      sessionId: "s1",
      turnId: "t2",
      status: "completed",
      agentId: "c",
    });
    signIn.fingerprint = "keychain:2";
    await recovery.probe();
    expect(retried).toEqual([]);
  });

  it("leaves a turn that may no longer run again by itself", async () => {
    const { recovery, signIn, retried, failedTurns, fail } = tracked();
    fail("t1");
    failedTurns.delete("t1");
    signIn.fingerprint = "keychain:2";
    await recovery.probe();
    expect(retried).toEqual([]);
  });

  it("ignores failures that are not about the sign-in", async () => {
    const { recovery, signIn, retried } = tracked();
    recovery.settled({
      projectId: "p",
      sessionId: "s1",
      turnId: "t1",
      status: "failed",
      errorKind: "rate_limit",
      agentId: "c",
    });
    signIn.fingerprint = "keychain:2";
    await recovery.probe();
    await recovery.signedIn("c");
    expect(retried).toEqual([]);
  });

  it("keeps the first sight of a failure when its chat reports it again", async () => {
    const { recovery, signIn, retried, fail, shown } = tracked();
    fail("t1");
    await recovery.probe();
    signIn.fingerprint = "keychain:2";
    // The chat shows the same failure after the change: still a change.
    shown("t1");
    await recovery.probe();
    expect(retried).toHaveLength(1);
  });

  it("runs a turn that fails again only on the next change, gives up after three, and stops looking", async () => {
    const { recovery, signIn, retried, fail, shown, reads } = tracked();
    fail("t1");
    for (let change = 2; change <= 6; change += 1) {
      signIn.fingerprint = `keychain:${change}`;
      await recovery.probe();
      await recovery.probe();
      // It failed on its sign-in again.
      fail("t1");
    }
    expect(retried).toHaveLength(3);
    // Its chat showing it again starts no more reads of the sign-in.
    const before = reads();
    shown("t1");
    await recovery.probe();
    expect(reads()).toBe(before);
    // Work's own re-login still runs it: the person asked.
    await recovery.signedIn("c");
    expect(retried).toHaveLength(4);
  });

  it("gives a later failed turn of the chat runs of its own", async () => {
    const { recovery, signIn, retried, fail } = tracked();
    for (let change = 2; change <= 4; change += 1) {
      fail("t1");
      signIn.fingerprint = `keychain:${change}`;
      await recovery.probe();
    }
    expect(retried).toHaveLength(3);
    fail("t2");
    signIn.fingerprint = "keychain:9";
    await recovery.probe();
    expect(retried.map((failure) => failure.turnId)).toEqual([
      "t1",
      "t1",
      "t1",
      "t2",
    ]);
  });

  it("forgets a failure half an hour after it was seen", async () => {
    const { recovery, signIn, retried, fail, advance } = tracked();
    fail("t1");
    advance(29 * 60_000);
    await recovery.probe();
    advance(60_000);
    signIn.fingerprint = "keychain:2";
    await recovery.probe();
    await recovery.signedIn("c");
    expect(retried).toEqual([]);
  });

  it("forgets nothing while the person is away, and watches afresh once they are back", async () => {
    const { recovery, signIn, retried, fail, advance } = tracked();
    // A chat's background task finished in the night; its turn failed.
    recovery.left();
    fail("t1");
    advance(6 * 60 * 60_000);
    await recovery.probe();
    expect(retried).toEqual([]);
    // Back: the Mac woke or unlocked. Its sign-in can still refresh, and a
    // new Claude Code renews an expired token itself: the turn runs again.
    await recovery.returned();
    expect(retried.map((failure) => failure.turnId)).toEqual(["t1"]);
    // And only once for that return.
    signIn.usable = true;
    await recovery.returned();
    expect(retried).toHaveLength(1);
  });

  it("on return runs only failures seen here, while the sign-in can refresh", async () => {
    const { recovery, signIn, retried, fail, shown, advance } = tracked();
    recovery.left();
    signIn.usable = false;
    fail("t1", "s1");
    shown("t2", "s2");
    advance(60 * 60_000);
    // A sign-in that cannot refresh waits for a change.
    await recovery.returned();
    expect(retried).toEqual([]);
    // Still watched after the return, as if just seen: the change runs both.
    signIn.usable = true;
    signIn.fingerprint = "keychain:2";
    advance(20 * 60_000);
    await recovery.probe();
    expect(retried.map((failure) => failure.turnId).sort()).toEqual([
      "t1",
      "t2",
    ]);
  });

  it("looks every few seconds after a failure, then only when asked", async () => {
    vi.useFakeTimers();
    const { signIn, retried, fail } = tracked();
    fail("t1");
    signIn.fingerprint = "keychain:2";
    await vi.advanceTimersByTimeAsync(5_000);
    expect(retried).toHaveLength(1);
  });
});

describe("mayRunAgain (ADR 0228)", () => {
  const turn = (overrides: Partial<Turn> = {}): Turn => ({
    id: "t1",
    sessionId: "s1",
    ordinal: 1,
    status: "failed",
    inputItemId: "i1",
    dispatch: "queue",
    priority: 0,
    activity: null,
    activityAt: null,
    attemptCount: 2,
    activeAttemptId: null,
    providerThreadId: null,
    retryAt: null,
    cancellationRequested: false,
    error: { message: "401 OAuth access token has expired", kind: "auth" },
    outcome: null,
    checkpoint: { before: null, after: null },
    continuationOf: null,
    createdAt: "2026-10-13T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-10-13T00:00:00.000Z",
    ...overrides,
  });
  const common = {
    sessionId: "s1",
    turnId: "t1",
    attemptId: null,
    parentItemId: null,
    position: 0,
    status: "completed" as const,
    nativeRef: null,
    createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:00:00.000Z",
    startedAt: null,
    endedAt: null,
  };
  const delivery = {
    dispatch: "queue" as const,
    attention: null,
    idempotencyKey: null,
    deliveredBy: "desktop",
    causation: [],
  };
  const message: Item = {
    ...delivery,
    ...common,
    id: "i1",
    kind: "user_message",
    author: { kind: "user", externalUserId: "desktop" },
    text: "hello",
    attachments: [],
  };
  const session: Parameters<typeof mayRunAgain>[0]["session"] = {
    status: "active",
    visibility: "promoted",
    archivedAt: null,
    parentSessionId: null,
  };
  const check = (input: {
    turns?: Turn[];
    items?: Item[];
    session?: Partial<typeof session>;
  }) =>
    mayRunAgain({
      turnId: "t1",
      session: { ...session, ...input.session },
      turns: input.turns ?? [turn()],
      items: input.items ?? [message],
    });

  it("holds for the person's own message in a chat they keep", () => {
    expect(check({})).toBe(true);
  });

  it("never once something came after the turn, or it is not a sign-in failure", () => {
    expect(
      check({ turns: [turn(), turn({ id: "t2", status: "queued" })] }),
    ).toBe(false);
    expect(check({ turns: [turn({ status: "completed", error: null })] })).toBe(
      false,
    );
    expect(
      check({
        turns: [turn({ error: { message: "slow down", kind: "rate_limit" } })],
      }),
    ).toBe(false);
  });

  it("never in a chat put away, closed, delegated, or continued elsewhere", () => {
    expect(check({ session: { archivedAt: "2026-10-13T01:00:00.000Z" } })).toBe(
      false,
    );
    expect(check({ session: { visibility: "archived" } })).toBe(false);
    expect(check({ session: { visibility: "latent" } })).toBe(false);
    expect(check({ session: { status: "closed" } })).toBe(false);
    expect(check({ session: { parentSessionId: "parent" } })).toBe(false);
    expect(
      check({
        items: [
          message,
          {
            ...common,
            id: "n1",
            turnId: null,
            kind: "notice",
            code: "mirror_fork",
            text: "Continued on work.example. This copy is history now.",
            data: {},
          },
        ],
      }),
    ).toBe(false);
  });

  it("holds for a turn one of the chat's own background tasks started", () => {
    expect(
      check({
        items: [
          {
            ...common,
            ...delivery,
            id: "i1",
            kind: "task_notification",
            task: {
              type: "background_command",
              id: "b1",
              title: "Run the merge gate",
              status: "completed",
            },
            summary: "Run the merge gate finished",
            detail: "exit=0",
            source: null,
          },
        ],
      }),
    ).toBe(true);
  });

  it("never for a turn a workflow, an automation or another agent started", () => {
    expect(
      check({
        items: [
          {
            ...common,
            ...delivery,
            id: "i1",
            kind: "inbound_message",
            from: { kind: "workflow", runId: "r1", workflowName: "nightly" },
            text: "run the report",
            attachments: [],
          },
        ],
      }),
    ).toBe(false);
    expect(check({ turns: [turn({ inputItemId: null })] })).toBe(false);
  });
});
