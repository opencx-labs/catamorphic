import type {
  CodexSignIn,
  CodexSignInState,
  CodexSignInStatus,
  RemoteMachine,
} from "../shared/remote-machines.js";

/*
 * The member's own machines on a linked project's server, and Codex
 * sign-ins on them (ADR 0213). Every failure is a plain Error in the
 * server's words: one crosses IPC without a class name in front.
 */

/** One JSON request to the member's machines on the project's server. */
export type RemoteMachinesRequest = (input: {
  method: "GET" | "POST" | "DELETE";
  /** Below `/work/me/machines`; `""` for the list. */
  path: string;
}) => Promise<{ status: number; body: unknown }>;

const UNREACHABLE = "The project's server could not be reached.";
const SIGN_IN_AGAIN = "Sign in to this project's server again.";

const SIGN_IN_STATES: readonly CodexSignInState[] = [
  "waiting",
  "signed-in",
  "failed",
  "expired",
  "cancelled",
];

/**
 * The machines the member may sign in on, or null when the server has no
 * such route (an older server, or the project lost its link).
 */
export async function listRemoteMachines(input: {
  request: RemoteMachinesRequest;
}): Promise<RemoteMachine[] | null> {
  const response = await send(input.request, { method: "GET", path: "" });
  if (response.status === 404) return null;
  if (response.status !== 200) throw new Error(failure(response));
  const machines = field(response.body, "machines");
  if (!Array.isArray(machines))
    throw new Error("The project's server sent an unreadable machine list.");
  return machines.flatMap((machine): RemoteMachine[] => {
    const id = field(machine, "id");
    const name = field(machine, "name");
    if (typeof id !== "string" || typeof name !== "string") return [];
    return [
      {
        id,
        name,
        available: field(machine, "available") === true,
        codex:
          field(machine, "codex") === "signed-in" ? "signed-in" : "signed-out",
      },
    ];
  });
}

/**
 * Start Codex's device code sign-in on one of the member's machines. A 409
 * is either the machine being offline (`machine_offline`) or the machine
 * refusing a login (`sign_in_refused`, such as another person's sign-in
 * already there); either way the server's words say which.
 */
export async function beginCodexSignIn(input: {
  request: RemoteMachinesRequest;
  machineId: string;
}): Promise<CodexSignIn> {
  const response = await send(input.request, {
    method: "POST",
    path: `/${encodeURIComponent(input.machineId)}/codex/sign-in`,
  });
  if (response.status !== 201 && response.status !== 200)
    throw new Error(
      failure(response, {
        403: "You cannot sign in to Codex on this machine.",
        409:
          field(response.body, "code") === "machine_offline"
            ? "This machine is not connected right now."
            : "This machine would not start a Codex sign-in.",
        502: "Codex could not start a sign-in on this machine.",
      }),
    );
  const attempt = field(response.body, "attempt");
  const verificationUrl = field(response.body, "verificationUrl");
  const userCode = field(response.body, "userCode");
  const expiresAt = field(response.body, "expiresAt");
  if (
    typeof attempt !== "string" ||
    typeof verificationUrl !== "string" ||
    typeof userCode !== "string" ||
    typeof expiresAt !== "string"
  )
    throw new Error("The project's server sent an unreadable sign-in.");
  return { attempt, verificationUrl, userCode, expiresAt };
}

/**
 * Where a sign-in stands. One the server no longer knows (it restarted)
 * has failed, so the person can try again.
 */
export async function codexSignInStatus(input: {
  request: RemoteMachinesRequest;
  machineId: string;
  attempt: string;
}): Promise<CodexSignInStatus> {
  const response = await send(input.request, {
    method: "GET",
    path: attemptPath(input),
  });
  if (response.status === 404)
    return {
      state: "failed",
      message: failure(response, {
        404: "The project's server no longer has this sign-in.",
      }),
    };
  if (response.status !== 200) throw new Error(failure(response));
  const state = SIGN_IN_STATES.find(
    (known) => known === field(response.body, "state"),
  );
  if (!state)
    throw new Error("The project's server sent an unknown sign-in state.");
  const message = field(response.body, "message");
  return typeof message === "string" && message.trim()
    ? { state, message }
    : { state };
}

/** Cancel a sign-in; one already gone needs nothing. */
export async function cancelCodexSignIn(input: {
  request: RemoteMachinesRequest;
  machineId: string;
  attempt: string;
}): Promise<void> {
  const response = await send(input.request, {
    method: "DELETE",
    path: attemptPath(input),
  });
  if (response.status !== 200 && response.status !== 404)
    throw new Error(failure(response));
}

/** Sign out of Codex on one of the member's machines. */
export async function signOutOfCodex(input: {
  request: RemoteMachinesRequest;
  machineId: string;
}): Promise<{ signedOut: boolean }> {
  const response = await send(input.request, {
    method: "DELETE",
    path: `/${encodeURIComponent(input.machineId)}/codex`,
  });
  if (response.status !== 200) throw new Error(failure(response));
  return { signedOut: field(response.body, "signedOut") === true };
}

function attemptPath(input: { machineId: string; attempt: string }): string {
  return `/${encodeURIComponent(input.machineId)}/codex/sign-in/${encodeURIComponent(input.attempt)}`;
}

/** The request, with a transport failure in words a person can act on. */
async function send(
  request: RemoteMachinesRequest,
  input: Parameters<RemoteMachinesRequest>[0],
): Promise<{ status: number; body: unknown }> {
  try {
    return await request(input);
  } catch (error) {
    // fetch rejects with a TypeError when the server cannot be reached.
    throw new Error(
      error instanceof TypeError
        ? UNREACHABLE
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }
}

/** The server's own message for a failed request. */
function failure(
  response: { status: number; body: unknown },
  fallbacks: Partial<Record<number, string>> = {},
): string {
  if (response.status === 401) return SIGN_IN_AGAIN;
  const error = field(response.body, "error");
  if (typeof error === "string" && error.trim()) return error;
  return (
    fallbacks[response.status] ??
    `The project's server answered ${response.status}.`
  );
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
}
