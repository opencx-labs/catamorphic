import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createWorkServer, type WorkServer } from "../server.js";
import { oauthAccessToken, testServerOptions } from "../test-support.js";
import { listMachineSignIns, signInRoot } from "./sign-ins.js";

/**
 * A single person's server holds their Claude Code and Codex sign-ins on
 * its own machine (ADRs 0213, 0340): with its operator's
 * `WORK_PERSONAL_CREDENTIALS=accept`, the server's machine is a member's
 * own for the first member to sign in there, and for no one else after.
 */

/** What a member pastes from the stand-in Claude sign-in page. */
const CLAUDE_CODE = "TEST-CLAUDE-CODE#state";

const PASSWORD = "correct horse battery staple";
let root = "";
let server: WorkServer;
const tokens: Record<"alice" | "bob", string> = { alice: "", bob: "" };

async function waitFor(check: () => Promise<boolean>, what: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const call = (
  method: "GET" | "POST" | "DELETE",
  url: string,
  as: "alice" | "bob",
  body?: unknown,
) =>
  server.app.inject({
    method,
    url: `/api/work/me/machines${url}`,
    headers: {
      authorization: `Bearer ${tokens[as]}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });

const MachinesSchema = z.object({
  machines: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      available: z.boolean(),
      state: z.string(),
      reason: z.string().nullable(),
      signIns: z.strictObject({
        "claude-code": z.enum(["signed-in", "signed-out"]),
        codex: z.enum(["signed-in", "signed-out"]),
      }),
    }),
  ),
});
const machines = async (as: "alice" | "bob") =>
  MachinesSchema.parse((await call("GET", "", as)).json()).machines;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "work-own-sign-in-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.copyFileSync(
    path.join(import.meta.dirname, "fake-codex-cli.ts"),
    path.join(bin, "codex"),
  );
  fs.chmodSync(path.join(bin, "codex"), 0o755);
  fs.copyFileSync(
    path.join(import.meta.dirname, "fake-claude-cli.ts"),
    path.join(bin, "claude"),
  );
  fs.chmodSync(path.join(bin, "claude"), 0o755);
  server = await createWorkServer(
    testServerOptions({
      dataDir: path.join(root, "data"),
      env: {
        WORK_FAKE_AGENT: "1",
        WORK_PERSONAL_CREDENTIALS: "accept",
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    }),
  );
  const secret = fs
    .readFileSync(path.join(root, "data", "operator-secret"), "utf8")
    .trim();
  for (const who of ["alice", "bob"] as const) {
    const user = await server.operatorApp.inject({
      method: "POST",
      url: "/_work/operator/users",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        username: who,
        name: who,
        email: `${who}@example.test`,
        password: PASSWORD,
      }),
    });
    expect(user.statusCode).toBe(201);
    tokens[who] = await oauthAccessToken({
      app: server.app,
      username: who,
      password: PASSWORD,
    });
  }
}, 120_000);

afterAll(async () => {
  await server?.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a single person's server holds their sign-ins (ADRs 0213, 0340)", () => {
  it("is anyone's own machine until one member signs in there", async () => {
    const [own] = await machines("alice");
    expect(own?.signIns).toEqual({
      "claude-code": "signed-out",
      codex: "signed-out",
    });
    expect(await machines("bob")).toEqual([own]);
    const id = encodeURIComponent(own?.id ?? "");

    const started = await call("POST", `/${id}/codex/sign-in`, "alice");
    expect(started.statusCode).toBe(201);
    expect(started.json()).toMatchObject({ userCode: "TEST-12345" });
    const attempt = `/${id}/codex/sign-in/${started.json().attempt}`;
    const approve = path.join(signInRoot(path.join(root, "data")), "approve");
    fs.writeFileSync(approve, "codex-access-alice");
    await waitFor(
      async () =>
        (await call("GET", attempt, "alice")).json().state === "signed-in",
      "the sign-in to complete",
    );
    fs.rmSync(approve);
    // Signed in means placement already sees it.
    expect((await machines("alice"))[0]?.signIns).toEqual({
      "claude-code": "signed-out",
      codex: "signed-in",
    });

    // Hers now: Bob is offered it no longer, and may not sign in on it.
    expect(await machines("bob")).toEqual([]);
    expect((await call("POST", `/${id}/codex/sign-in`, "bob")).statusCode).toBe(
      403,
    );
    expect(
      listMachineSignIns(signInRoot(path.join(root, "data"))).map(
        (signIn) => signIn.member,
      ),
    ).toHaveLength(1);

    // Hers for Claude Code too: Bob may not sign in to that there either.
    expect(
      (await call("POST", `/${id}/claude-code/sign-in`, "bob")).statusCode,
    ).toBe(403);

    // Her Claude Code sign-in goes beside her Codex one. The machine runs
    // Claude Code's own login and hands back its link; it shows no code.
    const claude = await call("POST", `/${id}/claude-code/sign-in`, "alice");
    expect(claude.statusCode).toBe(201);
    expect(claude.json()).toMatchObject({ expects: "code" });
    expect(claude.json()).not.toHaveProperty("userCode");
    expect(new URL(claude.json().verificationUrl).hostname).toBe("claude.com");
    const claudeAttempt = `/${id}/claude-code/sign-in/${claude.json().attempt}`;
    expect((await call("GET", claudeAttempt, "alice")).json()).toEqual({
      state: "waiting",
    });
    // The route takes one line as { text }, from her, for that harness.
    expect(
      (await call("POST", `${claudeAttempt}/input`, "alice", {})).statusCode,
    ).toBe(400);
    expect(
      (
        await call("POST", `${claudeAttempt}/input`, "alice", {
          text: CLAUDE_CODE,
          more: true,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call("POST", `${claudeAttempt}/input`, "bob", {
          text: CLAUDE_CODE,
        })
      ).statusCode,
    ).toBe(403);
    const unknown = await call(
      "POST",
      `/${id}/emacs/sign-in/${claude.json().attempt}/input`,
      "alice",
      { text: CLAUDE_CODE },
    );
    expect(unknown.statusCode).toBe(404);
    expect(unknown.body).not.toContain(CLAUDE_CODE);
    // Codex's attempt takes no pasted code: it showed its own.
    const notCodex = await call(
      "POST",
      `/${id}/codex/sign-in/${claude.json().attempt}/input`,
      "alice",
      { text: CLAUDE_CODE },
    );
    expect(notCodex.statusCode).toBe(409);
    expect(notCodex.json()).toMatchObject({ code: "sign_in_refused" });
    expect(notCodex.body).not.toContain(CLAUDE_CODE);

    // She pastes the code her browser gave her; the answer never repeats it.
    const pasted = await call("POST", `${claudeAttempt}/input`, "alice", {
      text: CLAUDE_CODE,
    });
    expect(pasted.statusCode).toBe(200);
    expect(["waiting", "signed-in"]).toContain(pasted.json().state);
    expect(pasted.body).not.toContain(CLAUDE_CODE);
    await waitFor(
      async () =>
        (await call("GET", claudeAttempt, "alice")).json().state ===
        "signed-in",
      "the Claude Code sign-in to complete",
    );
    expect((await machines("alice"))[0]?.signIns).toEqual({
      "claude-code": "signed-in",
      codex: "signed-in",
    });
    const held = listMachineSignIns(signInRoot(path.join(root, "data")));
    expect(held.map((signIn) => signIn.harness)).toEqual([
      "claude-code",
      "codex",
    ]);
    // One person's, both.
    expect(new Set(held.map((signIn) => signIn.member)).size).toBe(1);

    // Signing out of one leaves the other, and the machine still hers.
    expect((await call("DELETE", `/${id}/codex`, "alice")).json()).toEqual({
      signedOut: true,
    });
    await waitFor(
      async () => (await machines("alice"))[0]?.signIns.codex === "signed-out",
      "the machine to stop reporting Codex",
    );
    expect(await machines("bob")).toEqual([]);
    expect((await call("DELETE", `/${id}/emacs`, "alice")).statusCode).toBe(
      404,
    );

    // Once she signs out of both, the machine is free again.
    expect(
      (await call("DELETE", `/${id}/claude-code`, "alice")).json(),
    ).toEqual({ signedOut: true });
    await waitFor(
      async () => (await machines("bob")).length === 1,
      "the machine to be free",
    );
  }, 120_000);
});
