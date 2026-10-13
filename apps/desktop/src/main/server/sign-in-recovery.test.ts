import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSignIn } from "../agent-credentials.js";
import {
  type SignInFailure,
  SignInRecovery,
  type SignInRecoveryDeps,
} from "./sign-in-recovery.js";

const claude: AgentSignIn = { harness: "claude-code", auth: "local", id: "c" };

function harness() {
  const signIn = { fingerprint: "keychain:1", usable: true };
  const retried: SignInFailure[] = [];
  const failedTurns = new Set<string>();
  const deps: SignInRecoveryDeps = {
    credentialAgentId: (agentId) => agentId.replace(/^assistant:/, ""),
    signInFor: (agentId) =>
      agentId === "router" ? undefined : { ...claude, id: agentId },
    readSignIn: async () => ({ ...signIn }),
    stillFailed: async (failure) => failedTurns.has(failure.turnId),
    retry: async (failure) => {
      retried.push(failure);
      failedTurns.delete(failure.turnId);
    },
  };
  const recovery = new SignInRecovery(deps);
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
  return { recovery, signIn, retried, failedTurns, fail };
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

describe("SignInRecovery (ADR 0227)", () => {
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

  it("waits while the changed sign-in still cannot run a turn", async () => {
    const { recovery, signIn, retried, fail } = tracked();
    fail("t1");
    signIn.fingerprint = "keychain:2";
    signIn.usable = false;
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

  it("leaves a turn that is no longer its chat's latest failure", async () => {
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
    const { recovery, signIn, retried, fail } = tracked();
    fail("t1");
    await recovery.probe();
    signIn.fingerprint = "keychain:2";
    // The chat shows the same failure after the change: still a change.
    recovery.failed({
      projectId: "p",
      sessionId: "s1",
      turnId: "t1",
      agentId: "c",
    });
    await recovery.probe();
    expect(retried).toHaveLength(1);
  });

  it("runs a turn that fails again only on the next change, and gives up after three", async () => {
    const { recovery, signIn, retried, fail } = tracked();
    fail("t1");
    for (let change = 2; change <= 6; change += 1) {
      signIn.fingerprint = `keychain:${change}`;
      await recovery.probe();
      await recovery.probe();
      // It failed on its sign-in again.
      fail("t1");
    }
    expect(retried).toHaveLength(3);
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
