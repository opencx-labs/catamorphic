import { describe, expect, it } from "vitest";
import { RemoteSignInRequiredError } from "./remote-api.js";
import {
  beginHarnessSignIn,
  cancelHarnessSignIn,
  harnessSignInStatus,
  listRemoteMachines,
  type RemoteMachinesRequest,
  signOutOfHarness,
  submitHarnessSignInCode,
} from "./remote-machines.js";

type Call = Parameters<RemoteMachinesRequest>[0];

/** A server answering every request the same way, recording each one. */
function server(status: number, body: unknown = null) {
  const calls: Call[] = [];
  const request: RemoteMachinesRequest = async (call) => {
    calls.push(call);
    return { status, body };
  };
  return { request, calls };
}

/** The error a call rejects with, as it would cross IPC. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (cause: unknown) => cause,
  );
  if (!(error instanceof Error)) throw new Error("expected an Error");
  return error;
}

describe("listRemoteMachines", () => {
  it("reads the member's machines and drops entries it cannot read", async () => {
    const { request, calls } = server(200, {
      machines: [
        {
          id: "m-1",
          name: "ada-devbox",
          available: true,
          signIns: { "claude-code": "signed-out", codex: "signed-in" },
        },
        {
          id: "m-2",
          name: "ada-gpu",
          available: false,
          signIns: { "claude-code": "signed-in", codex: "signed-out" },
        },
        // A state it cannot read is signed out, harness by harness.
        { id: "m-3", name: "ada-old", available: true, signIns: { codex: 1 } },
        { id: "m-4", name: "ada-older", available: true, codex: "signed-in" },
        { id: 3, name: "broken" },
      ],
    });
    const signedOut = { "claude-code": "signed-out", codex: "signed-out" };
    expect(await listRemoteMachines({ request })).toEqual([
      {
        id: "m-1",
        name: "ada-devbox",
        available: true,
        signIns: { "claude-code": "signed-out", codex: "signed-in" },
      },
      {
        id: "m-2",
        name: "ada-gpu",
        available: false,
        signIns: { "claude-code": "signed-in", codex: "signed-out" },
      },
      { id: "m-3", name: "ada-old", available: true, signIns: signedOut },
      { id: "m-4", name: "ada-older", available: true, signIns: signedOut },
    ]);
    expect(calls).toEqual([{ method: "GET", path: "" }]);
  });

  it("is not available on a server without the route", async () => {
    const { request } = server(404, {
      message: "Route GET:/api/work/me/machines not found",
      error: "Not Found",
      statusCode: 404,
    });
    expect(await listRemoteMachines({ request })).toBeNull();
  });

  it("fails in the server's own words, without a class name", async () => {
    const error = await rejection(
      listRemoteMachines({
        request: server(500, { error: "The machine directory is down." })
          .request,
      }),
    );
    expect(error.name).toBe("Error");
    expect(String(error)).toBe("Error: The machine directory is down.");
  });

  it("asks to sign in again on a 401, and says when the server is unreachable", async () => {
    expect(
      (
        await rejection(
          listRemoteMachines({
            request: server(401, { error: "Unauthorized" }).request,
          }),
        )
      ).message,
    ).toBe("Sign in to this project's server again.");
    const offline = await rejection(
      listRemoteMachines({
        request: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    );
    expect(offline.name).toBe("Error");
    expect(offline.message).toBe("The project's server could not be reached.");
    const signedOut = await rejection(
      listRemoteMachines({
        request: async () => {
          throw new RemoteSignInRequiredError();
        },
      }),
    );
    expect(String(signedOut)).toBe(
      "Error: Sign in to this project's server to continue",
    );
  });
});

describe("Codex sign-in", () => {
  it("begins on the machine and returns the code to enter", async () => {
    const signIn = {
      attempt: "att-1",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1E2F3",
      expiresAt: "2026-10-06T12:15:00.000Z",
    };
    const { request, calls } = server(201, signIn);
    expect(
      await beginHarnessSignIn({ request, machineId: "m/1", harness: "codex" }),
    ).toEqual(signIn);
    expect(calls).toEqual([{ method: "POST", path: "/m%2F1/codex/sign-in" }]);
  });

  it("passes on why a sign-in could not start", async () => {
    for (const [status, body, message] of [
      [
        409,
        { error: "ada-devbox is not connected.", code: "machine_offline" },
        "ada-devbox is not connected.",
      ],
      [
        409,
        {
          error:
            "Another person's sign-in is on this machine, and a machine holds one person's only. Ask an administrator for a machine of your own",
          code: "sign_in_refused",
        },
        "Another person's sign-in is on this machine, and a machine holds one person's only. Ask an administrator for a machine of your own",
      ],
      [
        409,
        { code: "machine_offline" },
        "This machine is not connected right now.",
      ],
      [
        409,
        { code: "sign_in_refused" },
        "This machine would not start a Codex sign-in.",
      ],
      [
        502,
        { error: "Enable device code authorization for Codex in ChatGPT." },
        "Enable device code authorization for Codex in ChatGPT.",
      ],
      [403, null, "You cannot sign in to Codex on this machine."],
      [500, "oops", "The project's server answered 500."],
    ] as const) {
      const error = await rejection(
        beginHarnessSignIn({
          request: server(status, body).request,
          machineId: "m-1",
          harness: "codex",
        }),
      );
      expect(String(error)).toBe(`Error: ${message}`);
    }
  });

  it("refuses a sign-in it cannot read", async () => {
    const error = await rejection(
      beginHarnessSignIn({
        request: server(201, { attempt: "att-1" }).request,
        machineId: "m-1",
        harness: "codex",
      }),
    );
    expect(error.message).toBe(
      "The project's server sent an unreadable sign-in.",
    );
  });

  it("maps each state, with the server's message when it has one", async () => {
    const waiting = server(200, { state: "waiting" });
    expect(
      await harnessSignInStatus({
        request: waiting.request,
        machineId: "m-1",
        harness: "codex",
        attempt: "att 1",
      }),
    ).toEqual({ state: "waiting" });
    expect(waiting.calls).toEqual([
      { method: "GET", path: "/m-1/codex/sign-in/att%201" },
    ]);
    for (const state of ["signed-in", "expired", "cancelled"] as const)
      expect(
        await harnessSignInStatus({
          request: server(200, { state, message: "" }).request,
          machineId: "m-1",
          harness: "codex",
          attempt: "att-1",
        }),
      ).toEqual({ state });
    expect(
      await harnessSignInStatus({
        request: server(200, {
          state: "failed",
          message: "Codex exited before the code was entered.",
        }).request,
        machineId: "m-1",
        harness: "codex",
        attempt: "att-1",
      }),
    ).toEqual({
      state: "failed",
      message: "Codex exited before the code was entered.",
    });
  });

  it("treats a sign-in the server no longer knows as failed", async () => {
    expect(
      await harnessSignInStatus({
        request: server(404, { error: "No such sign-in." }).request,
        machineId: "m-1",
        harness: "codex",
        attempt: "att-1",
      }),
    ).toEqual({ state: "failed", message: "No such sign-in." });
    expect(
      await harnessSignInStatus({
        request: server(404).request,
        machineId: "m-1",
        harness: "codex",
        attempt: "att-1",
      }),
    ).toEqual({
      state: "failed",
      message: "The project's server no longer has this sign-in.",
    });
  });

  it("rejects a state it does not know and a failed check", async () => {
    expect(
      (
        await rejection(
          harnessSignInStatus({
            request: server(200, { state: "pondering" }).request,
            machineId: "m-1",
            harness: "codex",
            attempt: "att-1",
          }),
        )
      ).message,
    ).toBe("The project's server sent an unknown sign-in state.");
    expect(
      String(
        await rejection(
          harnessSignInStatus({
            request: server(503, { error: "The server is restarting." })
              .request,
            machineId: "m-1",
            harness: "codex",
            attempt: "att-1",
          }),
        ),
      ),
    ).toBe("Error: The server is restarting.");
  });

  it("cancels an attempt, and one already gone needs nothing", async () => {
    const { request, calls } = server(200, { ok: true });
    await cancelHarnessSignIn({
      request,
      machineId: "m-1",
      harness: "codex",
      attempt: "att-1",
    });
    expect(calls).toEqual([
      { method: "DELETE", path: "/m-1/codex/sign-in/att-1" },
    ]);
    await expect(
      cancelHarnessSignIn({
        request: server(404).request,
        machineId: "m-1",
        harness: "codex",
        attempt: "att-1",
      }),
    ).resolves.toBeUndefined();
    expect(
      (
        await rejection(
          cancelHarnessSignIn({
            request: server(500, { error: "Could not stop Codex." }).request,
            machineId: "m-1",
            harness: "codex",
            attempt: "att-1",
          }),
        )
      ).message,
    ).toBe("Could not stop Codex.");
  });

  it("signs out of Codex on a machine", async () => {
    const { request, calls } = server(200, { signedOut: true });
    expect(
      await signOutOfHarness({ request, machineId: "m-1", harness: "codex" }),
    ).toEqual({
      signedOut: true,
    });
    expect(calls).toEqual([{ method: "DELETE", path: "/m-1/codex" }]);
    expect(
      await signOutOfHarness({
        request: server(200, { signedOut: false }).request,
        machineId: "m-1",
        harness: "codex",
      }),
    ).toEqual({ signedOut: false });
    expect(
      (
        await rejection(
          signOutOfHarness({
            request: server(403, { error: "Not your machine." }).request,
            machineId: "m-1",
            harness: "codex",
          }),
        )
      ).message,
    ).toBe("Not your machine.");
  });
});

describe("Claude Code sign-in", () => {
  const link =
    "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code";

  it("begins on the machine and returns the link, with a code to bring back", async () => {
    const signIn = {
      attempt: "att-1",
      verificationUrl: link,
      expects: "code",
      expiresAt: "2026-11-20T12:15:00.000Z",
    };
    const { request, calls } = server(201, signIn);
    expect(
      await beginHarnessSignIn({
        request,
        machineId: "m/1",
        harness: "claude-code",
      }),
    ).toEqual(signIn);
    expect(calls).toEqual([
      { method: "POST", path: "/m%2F1/claude-code/sign-in" },
    ]);
    // Neither a code to enter nor one to bring back is no sign-in.
    expect(
      (
        await rejection(
          beginHarnessSignIn({
            request: server(201, {
              attempt: "att-1",
              verificationUrl: link,
              expiresAt: "2026-11-20T12:15:00.000Z",
            }).request,
            machineId: "m-1",
            harness: "claude-code",
          }),
        )
      ).message,
    ).toBe("The project's server sent an unreadable sign-in.");
  });

  it("says in Claude Code's name why a sign-in could not start", async () => {
    for (const [status, body, message] of [
      [403, null, "You cannot sign in to Claude Code on this machine."],
      [
        404,
        // An older server's own answer for a route it does not have.
        { message: "Route POST:/x not found", error: "Not Found" },
        "This project's server does not sign people in to Claude Code on their machines.",
      ],
      [
        409,
        { code: "sign_in_refused" },
        "This machine would not start a Claude Code sign-in.",
      ],
      [502, null, "Claude Code could not start a sign-in on this machine."],
    ] as const) {
      const error = await rejection(
        beginHarnessSignIn({
          request: server(status, body).request,
          machineId: "m-1",
          harness: "claude-code",
        }),
      );
      expect(String(error)).toBe(`Error: ${message}`);
    }
  });

  it("hands the machine the pasted code, in a body, and reads where the sign-in stands", async () => {
    const code = "pasted-code-7f3a#state";
    const { request, calls } = server(200, { state: "waiting" });
    expect(
      await submitHarnessSignInCode({
        request,
        machineId: "m-1",
        harness: "claude-code",
        attempt: "att 1",
        text: code,
      }),
    ).toEqual({ state: "waiting" });
    // Never in the path, where servers and proxies log it.
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/m-1/claude-code/sign-in/att%201/input",
        body: { text: code },
      },
    ]);
    expect(
      await submitHarnessSignInCode({
        request: server(200, {
          state: "failed",
          message: "Error: invalid code the code",
        }).request,
        machineId: "m-1",
        harness: "claude-code",
        attempt: "att-1",
        text: code,
      }),
    ).toEqual({ state: "failed", message: "Error: invalid code the code" });
  });

  it("says why a code was not taken, never repeating it", async () => {
    const code = "pasted-code-7f3a#state";
    for (const [status, body, message] of [
      [400, null, "Paste the code the sign-in page gave you."],
      [404, null, "This project's server takes no code for this sign-in."],
      [
        409,
        {
          error:
            "This sign-in already has its code. Wait for it to finish, or start again",
          code: "sign_in_refused",
        },
        "This sign-in already has its code. Wait for it to finish, or start again",
      ],
      [
        409,
        { code: "sign_in_refused" },
        "This machine would not take the code.",
      ],
      [
        409,
        { code: "machine_offline" },
        "This machine is not connected right now.",
      ],
      [401, null, "Sign in to this project's server again."],
    ] as const) {
      const error = await rejection(
        submitHarnessSignInCode({
          request: server(status, body).request,
          machineId: "m-1",
          harness: "claude-code",
          attempt: "att-1",
          text: code,
        }),
      );
      expect(String(error)).toBe(`Error: ${message}`);
      expect(String(error)).not.toContain(code);
    }
    const offline = await rejection(
      submitHarnessSignInCode({
        request: async () => {
          throw new TypeError(`fetch failed for ${code}`);
        },
        machineId: "m-1",
        harness: "claude-code",
        attempt: "att-1",
        text: code,
      }),
    );
    expect(offline.message).toBe("The project's server could not be reached.");
  });

  it("checks, cancels and signs out by harness", async () => {
    const status = server(200, { state: "signed-in" });
    expect(
      await harnessSignInStatus({
        request: status.request,
        machineId: "m-1",
        harness: "claude-code",
        attempt: "att-1",
      }),
    ).toEqual({ state: "signed-in" });
    const cancel = server(200, { ok: true });
    await cancelHarnessSignIn({
      request: cancel.request,
      machineId: "m-1",
      harness: "claude-code",
      attempt: "att-1",
    });
    const out = server(200, { signedOut: true });
    expect(
      await signOutOfHarness({
        request: out.request,
        machineId: "m-1",
        harness: "claude-code",
      }),
    ).toEqual({ signedOut: true });
    expect([...status.calls, ...cancel.calls, ...out.calls]).toEqual([
      { method: "GET", path: "/m-1/claude-code/sign-in/att-1" },
      { method: "DELETE", path: "/m-1/claude-code/sign-in/att-1" },
      { method: "DELETE", path: "/m-1/claude-code" },
    ]);
  });
});
