import { describe, expect, it } from "vitest";
import { RemoteSignInRequiredError } from "./remote-api.js";
import {
  beginCodexSignIn,
  cancelCodexSignIn,
  codexSignInStatus,
  listRemoteMachines,
  type RemoteMachinesRequest,
  signOutOfCodex,
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
        { id: "m-1", name: "ada-devbox", available: true, codex: "signed-in" },
        { id: "m-2", name: "ada-gpu", available: false, codex: "signed-out" },
        { id: 3, name: "broken" },
      ],
    });
    expect(await listRemoteMachines({ request })).toEqual([
      { id: "m-1", name: "ada-devbox", available: true, codex: "signed-in" },
      { id: "m-2", name: "ada-gpu", available: false, codex: "signed-out" },
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
    expect(await beginCodexSignIn({ request, machineId: "m/1" })).toEqual(
      signIn,
    );
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
        502,
        { error: "Enable device code authorization for Codex in ChatGPT." },
        "Enable device code authorization for Codex in ChatGPT.",
      ],
      [403, null, "You cannot sign in to Codex on this machine."],
      [500, "oops", "The project's server answered 500."],
    ] as const) {
      const error = await rejection(
        beginCodexSignIn({
          request: server(status, body).request,
          machineId: "m-1",
        }),
      );
      expect(String(error)).toBe(`Error: ${message}`);
    }
  });

  it("refuses a sign-in it cannot read", async () => {
    const error = await rejection(
      beginCodexSignIn({
        request: server(201, { attempt: "att-1" }).request,
        machineId: "m-1",
      }),
    );
    expect(error.message).toBe(
      "The project's server sent an unreadable sign-in.",
    );
  });

  it("maps each state, with the server's message when it has one", async () => {
    const waiting = server(200, { state: "waiting" });
    expect(
      await codexSignInStatus({
        request: waiting.request,
        machineId: "m-1",
        attempt: "att 1",
      }),
    ).toEqual({ state: "waiting" });
    expect(waiting.calls).toEqual([
      { method: "GET", path: "/m-1/codex/sign-in/att%201" },
    ]);
    for (const state of ["signed-in", "expired", "cancelled"] as const)
      expect(
        await codexSignInStatus({
          request: server(200, { state, message: "" }).request,
          machineId: "m-1",
          attempt: "att-1",
        }),
      ).toEqual({ state });
    expect(
      await codexSignInStatus({
        request: server(200, {
          state: "failed",
          message: "Codex exited before the code was entered.",
        }).request,
        machineId: "m-1",
        attempt: "att-1",
      }),
    ).toEqual({
      state: "failed",
      message: "Codex exited before the code was entered.",
    });
  });

  it("treats a sign-in the server no longer knows as failed", async () => {
    expect(
      await codexSignInStatus({
        request: server(404, { error: "No such sign-in." }).request,
        machineId: "m-1",
        attempt: "att-1",
      }),
    ).toEqual({ state: "failed", message: "No such sign-in." });
    expect(
      await codexSignInStatus({
        request: server(404).request,
        machineId: "m-1",
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
          codexSignInStatus({
            request: server(200, { state: "pondering" }).request,
            machineId: "m-1",
            attempt: "att-1",
          }),
        )
      ).message,
    ).toBe("The project's server sent an unknown sign-in state.");
    expect(
      String(
        await rejection(
          codexSignInStatus({
            request: server(503, { error: "The server is restarting." })
              .request,
            machineId: "m-1",
            attempt: "att-1",
          }),
        ),
      ),
    ).toBe("Error: The server is restarting.");
  });

  it("cancels an attempt, and one already gone needs nothing", async () => {
    const { request, calls } = server(200, { ok: true });
    await cancelCodexSignIn({ request, machineId: "m-1", attempt: "att-1" });
    expect(calls).toEqual([
      { method: "DELETE", path: "/m-1/codex/sign-in/att-1" },
    ]);
    await expect(
      cancelCodexSignIn({
        request: server(404).request,
        machineId: "m-1",
        attempt: "att-1",
      }),
    ).resolves.toBeUndefined();
    expect(
      (
        await rejection(
          cancelCodexSignIn({
            request: server(500, { error: "Could not stop Codex." }).request,
            machineId: "m-1",
            attempt: "att-1",
          }),
        )
      ).message,
    ).toBe("Could not stop Codex.");
  });

  it("signs out of Codex on a machine", async () => {
    const { request, calls } = server(200, { signedOut: true });
    expect(await signOutOfCodex({ request, machineId: "m-1" })).toEqual({
      signedOut: true,
    });
    expect(calls).toEqual([{ method: "DELETE", path: "/m-1/codex" }]);
    expect(
      await signOutOfCodex({
        request: server(200, { signedOut: false }).request,
        machineId: "m-1",
      }),
    ).toEqual({ signedOut: false });
    expect(
      (
        await rejection(
          signOutOfCodex({
            request: server(403, { error: "Not your machine." }).request,
            machineId: "m-1",
          }),
        )
      ).message,
    ).toBe("Not your machine.");
  });
});
