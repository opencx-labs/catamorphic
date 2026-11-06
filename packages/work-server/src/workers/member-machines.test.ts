import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createWorkServer, type WorkServer } from "../server.js";
import { oauthAccessToken, testServerOptions } from "../test-support.js";
import { listMachineSignIns, signInRoot } from "./sign-ins.js";

/**
 * A single person's server holds their Codex sign-in on its own machine
 * (ADR 0213): with its operator's `WORK_PERSONAL_CREDENTIALS=accept`, the
 * server's machine is a member's own for the first member to sign in
 * there, and for no one else after.
 */

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
) =>
  server.app.inject({
    method,
    url: `/api/work/me/machines${url}`,
    headers: { authorization: `Bearer ${tokens[as]}` },
  });

const MachinesSchema = z.object({
  machines: z.array(z.object({ id: z.string(), codex: z.string() })),
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

describe("a single person's server holds their Codex sign-in (ADR 0213)", () => {
  it("is anyone's own machine until one member signs in there", async () => {
    const [own] = await machines("alice");
    expect(own).toMatchObject({ codex: "signed-out" });
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
    expect((await machines("alice"))[0]?.codex).toBe("signed-in");

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

    // Once she signs out, the machine is free again.
    expect((await call("DELETE", `/${id}/codex`, "alice")).json()).toEqual({
      signedOut: true,
    });
    await waitFor(
      async () => (await machines("bob")).length === 1,
      "the machine to be free",
    );
  }, 120_000);
});
