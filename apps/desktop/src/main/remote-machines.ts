import {
  type HarnessSignIn,
  type HarnessSignInState,
  type HarnessSignInStatus,
  type RemoteMachine,
  SIGN_IN_HARNESS_NAMES,
  type SignInHarness,
} from "../shared/remote-machines.js";

/*
 * The member's own machines on a linked project's server, and Claude Code
 * and Codex sign-ins on them (ADRs 0213, 0340). Every failure is a plain
 * Error in the server's words: one crosses IPC without a class name in
 * front. The code a member pastes for Claude Code goes to the server in a
 * request body and nowhere else: no error here repeats it.
 */

/** One JSON request to the member's machines on the project's server. */
export type RemoteMachinesRequest = (input: {
  method: "GET" | "POST" | "DELETE";
  /** Below `/work/me/machines`; `""` for the list. */
  path: string;
  body?: unknown;
}) => Promise<{ status: number; body: unknown }>;

const UNREACHABLE = "The project's server could not be reached.";
const SIGN_IN_AGAIN = "Sign in to this project's server again.";

const SIGN_IN_STATES: readonly HarnessSignInState[] = [
  "waiting",
  "signed-in",
  "failed",
  "expired",
  "cancelled",
];

/** One of the member's machines and a harness on it. */
interface Target {
  request: RemoteMachinesRequest;
  machineId: string;
  harness: SignInHarness;
}

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
        signIns: {
          "claude-code": signInState(machine, "claude-code"),
          codex: signInState(machine, "codex"),
        },
      },
    ];
  });
}

/**
 * Start a harness's own sign-in on one of the member's machines. A 409 is
 * either the machine being offline (`machine_offline`) or the machine
 * refusing a login (`sign_in_refused`, such as another person's sign-in
 * already there); either way the server's words say which.
 */
export async function beginHarnessSignIn(
  input: Target,
): Promise<HarnessSignIn> {
  const { name } = SIGN_IN_HARNESS_NAMES[input.harness];
  const response = await send(input.request, {
    method: "POST",
    path: `${harnessPath(input)}/sign-in`,
  });
  // A server without the route for this harness answers with its
  // framework's own words, which say nothing to a person.
  if (response.status === 404)
    throw new Error(
      `This project's server does not sign people in to ${name} on their machines.`,
    );
  if (response.status !== 201 && response.status !== 200)
    throw new Error(
      failure(response, {
        403: `You cannot sign in to ${name} on this machine.`,
        409:
          field(response.body, "code") === "machine_offline"
            ? "This machine is not connected right now."
            : `This machine would not start a ${name} sign-in.`,
        502: `${name} could not start a sign-in on this machine.`,
      }),
    );
  const attempt = field(response.body, "attempt");
  const verificationUrl = field(response.body, "verificationUrl");
  const userCode = field(response.body, "userCode");
  const expects = field(response.body, "expects");
  const expiresAt = field(response.body, "expiresAt");
  if (
    typeof attempt !== "string" ||
    typeof verificationUrl !== "string" ||
    typeof expiresAt !== "string" ||
    // A sign-in either shows a code or waits for one.
    (typeof userCode !== "string" && expects !== "code")
  )
    throw new Error("The project's server sent an unreadable sign-in.");
  return {
    attempt,
    verificationUrl,
    ...(typeof userCode === "string" ? { userCode } : {}),
    ...(expects === "code" ? { expects } : {}),
    expiresAt,
  };
}

/**
 * Where a sign-in stands. One the server no longer knows (it restarted)
 * has failed, so the person can try again.
 */
export async function harnessSignInStatus(
  input: Target & { attempt: string },
): Promise<HarnessSignInStatus> {
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
  return readStatus(response.body);
}

/**
 * Hand the machine the code the sign-in page gave the person. The answer
 * says where the sign-in stands; a refusal (`sign_in_refused`) is in the
 * machine's words.
 */
export async function submitHarnessSignInCode(
  input: Target & { attempt: string; text: string },
): Promise<HarnessSignInStatus> {
  const response = await send(input.request, {
    method: "POST",
    path: `${attemptPath(input)}/input`,
    body: { text: input.text },
  });
  if (response.status !== 200)
    throw new Error(
      failure(response, {
        400: "Paste the code the sign-in page gave you.",
        404: "This project's server takes no code for this sign-in.",
        409:
          field(response.body, "code") === "machine_offline"
            ? "This machine is not connected right now."
            : "This machine would not take the code.",
      }),
    );
  return readStatus(response.body);
}

/** Cancel a sign-in; one already gone needs nothing. */
export async function cancelHarnessSignIn(
  input: Target & { attempt: string },
): Promise<void> {
  const response = await send(input.request, {
    method: "DELETE",
    path: attemptPath(input),
  });
  if (response.status !== 200 && response.status !== 404)
    throw new Error(failure(response));
}

/** Sign out of a harness on one of the member's machines. */
export async function signOutOfHarness(
  input: Target,
): Promise<{ signedOut: boolean }> {
  const response = await send(input.request, {
    method: "DELETE",
    path: harnessPath(input),
  });
  if (response.status !== 200) throw new Error(failure(response));
  return { signedOut: field(response.body, "signedOut") === true };
}

function harnessPath(input: {
  machineId: string;
  harness: SignInHarness;
}): string {
  return `/${encodeURIComponent(input.machineId)}/${input.harness}`;
}

function attemptPath(input: {
  machineId: string;
  harness: SignInHarness;
  attempt: string;
}): string {
  return `${harnessPath(input)}/sign-in/${encodeURIComponent(input.attempt)}`;
}

/** A machine's state for one harness; anything unreadable is signed out. */
function signInState(
  machine: unknown,
  harness: SignInHarness,
): "signed-in" | "signed-out" {
  return field(field(machine, "signIns"), harness) === "signed-in"
    ? "signed-in"
    : "signed-out";
}

function readStatus(body: unknown): HarnessSignInStatus {
  const state = SIGN_IN_STATES.find((known) => known === field(body, "state"));
  if (!state)
    throw new Error("The project's server sent an unknown sign-in state.");
  const message = field(body, "message");
  return typeof message === "string" && message.trim()
    ? { state, message }
    : { state };
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
