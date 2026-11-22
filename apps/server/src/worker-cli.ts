import {
  listMachineSignIns,
  MachineHeldError,
  SIGN_IN_SPECS,
  type SignInHarness,
  signInHarness,
  signInOnMachine,
  signInRoot,
  signOutOnMachine,
} from "@catamorphic/work-server";

const USAGE = `Members' own sign-ins on this machine (ADRs 0199, 0213, 0342):

  work worker sign-in <claude-code|codex> --member <id> [-- <login args>]
      Run the harness's own login here, in this terminal, for one member:
      claude auth login for Claude Code, codex login --device-auth for
      Codex, unless you pass other login args. The member opens the link
      it prints in their own browser. Members usually sign in from the
      Work app instead.
  work worker sign-out <claude-code|codex> --member <id>
      Delete that member's sign-in from this machine.
  work worker sign-ins
      List who is signed in on this machine.

<id> is the member's Work user id. The sign-in stays on this machine:
Work never reads, copies or sends it. Sign in only on a machine of that
member's own; a machine holds one person's sign-ins at most.`;

/** The worker's machine-local commands, or undefined when argv names none. */
export function workerCommand(
  argv: readonly string[],
): ((env: Record<string, string | undefined>) => number) | undefined {
  const [command, ...rest] = argv;
  if (command === "help" || command === "--help" || command === "-h")
    return () => {
      console.log(USAGE);
      return 0;
    };
  if (command === "sign-ins")
    return (env) => {
      const signIns = listMachineSignIns(signInRoot(dataDir(env)));
      if (signIns.length === 0)
        console.log("No one is signed in on this machine.");
      for (const signIn of signIns)
        console.log(`${signIn.harness}\t${signIn.member}`);
      return 0;
    };
  if (command !== "sign-in" && command !== "sign-out") return undefined;
  const separator = rest.indexOf("--");
  const own = separator === -1 ? rest : rest.slice(0, separator);
  // Without its own, the login runs with the harness's default arguments.
  const loginArgs = separator === -1 ? undefined : rest.slice(separator + 1);
  const harness = signInHarness(own[0]);
  const memberFlag = own.indexOf("--member");
  const member = memberFlag === -1 ? undefined : own[memberFlag + 1];
  if (!harness || !member)
    return () => {
      console.error(USAGE);
      return 2;
    };
  return command === "sign-in"
    ? (env) => signIn({ env, harness, member, args: loginArgs })
    : (env) => {
        const removed = signOutOnMachine({
          dataDir: dataDir(env),
          harness,
          member,
        });
        console.log(
          removed
            ? `Signed ${member} out of ${SIGN_IN_SPECS[harness].name} on this machine.`
            : `${member} was not signed in to ${SIGN_IN_SPECS[harness].name} on this machine.`,
        );
        return 0;
      };
}

function signIn(input: {
  env: Record<string, string | undefined>;
  harness: SignInHarness;
  member: string;
  args: readonly string[] | undefined;
}): number {
  const name = SIGN_IN_SPECS[input.harness].name;
  console.log(
    `Signing ${input.member} in to ${name} on this machine. Complete the login below; it stays on this machine.`,
  );
  const result = loginHere(input);
  if (!result) return 1;
  const { home, exitCode, reason } = result;
  if (exitCode !== 0) {
    console.error(
      reason ? `${reason}.` : `The ${name} login exited with ${exitCode}.`,
    );
    return exitCode;
  }
  console.log(
    `Done. ${input.member}'s ${name} sign-in is in ${home}. A running worker reports it within seconds.`,
  );
  return 0;
}

/** The login, or undefined once a machine holding someone else's refused. */
function loginHere(input: {
  env: Record<string, string | undefined>;
  harness: SignInHarness;
  member: string;
  args: readonly string[] | undefined;
}): { home: string; exitCode: number; reason?: string } | undefined {
  try {
    return signInOnMachine({
      dataDir: dataDir(input.env),
      harness: input.harness,
      member: input.member,
      ...(input.args ? { args: input.args } : {}),
    });
  } catch (error) {
    if (!(error instanceof MachineHeldError)) throw error;
    console.error(error.message);
    return undefined;
  }
}

function dataDir(env: Record<string, string | undefined>): string {
  return env.WORK_DATA_DIR ?? "/data";
}
