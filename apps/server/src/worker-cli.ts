import {
  listMachineSignIns,
  MachineHeldError,
  signInOnMachine,
  signInRoot,
  signOutOnMachine,
} from "@catamorphic/work-server";

const USAGE = `Members' own Codex sign-ins on this machine (ADRs 0199, 0213):

  work worker sign-in codex --member <id> [-- <login args>]
      Run Codex's own login here, in this terminal, for one member. It
      signs in with a device code unless you pass other login args.
      Members usually sign in from the Work app instead.
  work worker sign-out codex --member <id>
      Delete that member's sign-in from this machine.
  work worker sign-ins
      List who is signed in on this machine.

<id> is the member's Work user id. The sign-in stays on this machine:
Work never reads, copies or sends it. Sign in only on a machine of that
member's own.`;

const CLAUDE_CODE_REFUSAL =
  "Claude Code subscriptions run only on a member's own computer, in the Work app (ADR 0213). On a server, Claude Code runs with an API key through the organization's model connection.";

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
  const loginArgs =
    separator === -1 ? ["--device-auth"] : rest.slice(separator + 1);
  if (own[0] === "claude-code" && command === "sign-in")
    return () => {
      console.error(CLAUDE_CODE_REFUSAL);
      return 2;
    };
  const memberFlag = own.indexOf("--member");
  const member = memberFlag === -1 ? undefined : own[memberFlag + 1];
  if (own[0] !== "codex" || !member)
    return () => {
      console.error(USAGE);
      return 2;
    };
  return command === "sign-in"
    ? (env) => signIn({ env, member, args: loginArgs })
    : (env) => {
        const removed = signOutOnMachine({
          dataDir: dataDir(env),
          harness: "codex",
          member,
        });
        console.log(
          removed
            ? `Signed ${member} out of Codex on this machine.`
            : `${member} was not signed in to Codex on this machine.`,
        );
        return 0;
      };
}

function signIn(input: {
  env: Record<string, string | undefined>;
  member: string;
  args: readonly string[];
}): number {
  console.log(
    `Signing ${input.member} in to Codex on this machine. Complete the login below; it stays on this machine.`,
  );
  const result = loginHere(input);
  if (!result) return 1;
  const { home, exitCode } = result;
  if (exitCode !== 0) {
    console.error(`The Codex login exited with ${exitCode}.`);
    return exitCode;
  }
  console.log(
    `Done. ${input.member}'s Codex sign-in is in ${home}. A running worker reports it within seconds.`,
  );
  return 0;
}

/** The login, or undefined once a machine holding someone else's refused. */
function loginHere(input: {
  env: Record<string, string | undefined>;
  member: string;
  args: readonly string[];
}): { home: string; exitCode: number } | undefined {
  try {
    return signInOnMachine({
      dataDir: dataDir(input.env),
      harness: "codex",
      member: input.member,
      args: input.args,
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
