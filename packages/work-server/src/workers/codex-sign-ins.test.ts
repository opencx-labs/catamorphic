import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CodexSignInRefusedError,
  CodexSignIns,
  parseDeviceCode,
} from "./codex-sign-ins.js";
import { listMachineSignIns, signInRoot } from "./sign-ins.js";

/**
 * A stand-in for `codex login --device-auth` (v0.160.0's output, colors
 * included). What it does after printing its code depends on FAKE_CODEX:
 * approve (writes its file and exits 0), deny (exits 1), hang, or refuse
 * before printing any code.
 */
const FAKE_CODEX = `#!/bin/sh
if [ "$1 $2" != "login --device-auth" ]; then echo "unexpected: $*" >&2; exit 2; fi
if [ "$FAKE_CODEX" = refuse ]; then
  echo "Error: device code login is not enabled for this workspace" >&2
  exit 1
fi
printf '\\nWelcome to Codex [v\\033[90m0.160.0\\033[0m]\\n\\n'
printf 'Follow these steps to sign in with ChatGPT using device code authorization:\\n\\n'
printf '1. Open this link in your browser and sign in to your account\\n   \\033[94mhttps://auth.openai.com/codex/device\\033[0m\\n\\n'
printf '2. Enter this one-time code \\033[90m(expires in 15 minutes)\\033[0m\\n   \\033[94mABCD-1E2F3\\033[0m\\n\\n'
case "$FAKE_CODEX" in
  approve) sleep 0.3; printf '{"tokens":"kept on this machine"}' > "$CODEX_HOME/auth.json"; echo "Successfully logged in"; exit 0 ;;
  deny) sleep 0.3; echo "Error: the request was denied" >&2; exit 1 ;;
  *) sleep 600 ;;
esac
`;

describe("Codex sign-ins started from the app (ADR 0213)", () => {
  let dataDir: string;
  let bin: string;
  const machines: CodexSignIns[] = [];

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "work-codex-sign-in-"));
    bin = path.join(dataDir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "codex"), FAKE_CODEX, { mode: 0o755 });
  });
  afterEach(() => {
    for (const machine of machines.splice(0)) machine.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const machine = (mode: string, now?: () => number) => {
    const signIns = new CodexSignIns({
      signInRoot: signInRoot(dataDir),
      dataDir,
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        FAKE_CODEX: mode,
      },
      ...(now ? { now } : {}),
    });
    machines.push(signIns);
    return signIns;
  };

  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("Timed out");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const pending = () =>
    fs.existsSync(path.join(signInRoot(dataDir), ".pending"))
      ? fs.readdirSync(path.join(signInRoot(dataDir), ".pending"))
      : [];

  it("reads the link and code Codex prints, colors and all", () => {
    expect(
      parseDeviceCode(
        "1. Open\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n   \u001b[94mABCD-1E2F3\u001b[0m\n",
      ),
    ).toEqual({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1E2F3",
      minutes: 15,
    });
    expect(
      parseDeviceCode("https://auth.openai.com/codex/device\n"),
    ).toBeUndefined();
  });

  it("hands back the link and code, then places the completed login", async () => {
    const signIns = machine("approve");
    const started = await signIns.begin({ member: "user|alice" });
    expect(started).toMatchObject({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1E2F3",
    });
    const minutes = (Date.parse(started.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
    // Pending, it is not a sign-in the machine reports.
    expect(listMachineSignIns(signInRoot(dataDir))).toEqual([]);
    await until(
      () =>
        signIns.status({ member: "user|alice", attempt: started.attempt })
          .state !== "waiting",
    );
    expect(
      signIns.status({ member: "user|alice", attempt: started.attempt }),
    ).toEqual({ state: "signed-in" });
    const [signIn] = listMachineSignIns(signInRoot(dataDir));
    expect(signIn?.member).toBe("user|alice");
    expect(fs.existsSync(path.join(signIn?.home ?? "", "auth.json"))).toBe(
      true,
    );
    expect(pending()).toEqual([]);
  });

  it("says what Codex said when it refuses before giving a code", async () => {
    const signIns = machine("refuse");
    await expect(signIns.begin({ member: "alice" })).rejects.toThrow(
      new CodexSignInRefusedError(
        "Error: device code login is not enabled for this workspace",
      ),
    );
    expect(pending()).toEqual([]);
    expect(listMachineSignIns(signInRoot(dataDir))).toEqual([]);
  });

  it("keeps the sign-in a member had when a new login is denied or cancelled", async () => {
    const first = machine("approve");
    const done = await first.begin({ member: "alice" });
    await until(
      () =>
        first.status({ member: "alice", attempt: done.attempt }).state ===
        "signed-in",
    );

    const denied = machine("deny");
    const refused = await denied.begin({ member: "alice" });
    await until(
      () =>
        denied.status({ member: "alice", attempt: refused.attempt }).state !==
        "waiting",
    );
    expect(
      denied.status({ member: "alice", attempt: refused.attempt }),
    ).toEqual({ state: "failed", message: "Error: the request was denied" });

    const hanging = machine("hang");
    const waiting = await hanging.begin({ member: "alice" });
    expect(
      hanging.cancel({ member: "alice", attempt: waiting.attempt }),
    ).toEqual({ state: "cancelled" });

    expect(listMachineSignIns(signInRoot(dataDir))).toHaveLength(1);
    await until(() => pending().length === 0);
  });

  it("answers only the member who started a login, and one login per member", async () => {
    const signIns = machine("hang");
    const first = await signIns.begin({ member: "alice" });
    expect(signIns.status({ member: "bob", attempt: first.attempt })).toEqual({
      state: "failed",
      message:
        "This machine no longer knows this sign-in; it may have restarted. Start again",
    });
    expect(
      signIns.cancel({ member: "bob", attempt: first.attempt }).state,
    ).toBe("failed");
    expect(
      signIns.status({ member: "alice", attempt: first.attempt }).state,
    ).toBe("waiting");
    const second = await signIns.begin({ member: "alice" });
    expect(signIns.status({ member: "alice", attempt: first.attempt })).toEqual(
      { state: "cancelled", message: "A newer sign-in replaced this one" },
    );
    expect(
      signIns.status({ member: "alice", attempt: second.attempt }).state,
    ).toBe("waiting");
  });

  it("calls a login that ends after its code expired expired", async () => {
    let clock = Date.now();
    const signIns = machine("deny", () => clock);
    const started = await signIns.begin({ member: "alice" });
    clock += 16 * 60_000;
    await until(
      () =>
        signIns.status({ member: "alice", attempt: started.attempt }).state !==
        "waiting",
    );
    expect(
      signIns.status({ member: "alice", attempt: started.attempt }).state,
    ).toBe("expired");
  });

  it("holds one person's sign-in: another's login is refused, as an answer", async () => {
    const signIns = machine("approve");
    const started = await signIns.begin({ member: "alice" });
    await until(
      () =>
        signIns.status({ member: "alice", attempt: started.attempt }).state ===
        "signed-in",
    );
    expect(await signIns.handle({ action: "begin", member: "bob" })).toEqual({
      refused:
        "Another person's Codex sign-in is on this machine, and a machine holds one person's only. Ask an administrator for a machine of your own",
    });
    expect(pending()).toEqual([]);
    // Alice may sign in again; it replaces her own.
    const again = await signIns.begin({ member: "alice" });
    await until(
      () =>
        signIns.status({ member: "alice", attempt: again.attempt }).state ===
        "signed-in",
    );
    expect(
      listMachineSignIns(signInRoot(dataDir)).map((signIn) => signIn.member),
    ).toEqual(["alice"]);
  });

  it("signs a member out of the machine", async () => {
    const signIns = machine("approve");
    const started = await signIns.begin({ member: "alice" });
    await until(
      () =>
        signIns.status({ member: "alice", attempt: started.attempt }).state ===
        "signed-in",
    );
    expect(
      await signIns.handle({ action: "signOut", member: "alice" }),
    ).toEqual({ signedOut: true });
    expect(listMachineSignIns(signInRoot(dataDir))).toEqual([]);
  });
});
