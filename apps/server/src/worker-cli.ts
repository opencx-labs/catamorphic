import {
  listMachineSignIns,
  signInOnMachine,
  signInRoot,
  signOutOnMachine,
} from "@catamorphic/work-server";

const HARNESSES = ["claude-code", "codex"] as const;
type Harness = (typeof HARNESSES)[number];

const USAGE = `Members' own sign-ins on this machine (ADR 0199):

  work worker sign-in <claude-code|codex> --member <id> [-- <login args>]
      Run the harness's own login here, in this terminal, for one member.
      Their chats then run on this machine on their own subscription.
  work worker sign-out <claude-code|codex> --member <id>
      Delete that member's sign-in from this machine.
  work worker sign-ins
      List who is signed in to what on this machine.

<id> is the member's Work user id. The sign-in stays on this machine:
Work never reads, copies or sends it.`;

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
  const loginArgs = separator === -1 ? [] : rest.slice(separator + 1);
  const harness = HARNESSES.find((entry) => entry === own[0]);
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
            ? `Signed ${member} out of ${harness} on this machine.`
            : `${member} was not signed in to ${harness} on this machine.`,
        );
        return 0;
      };
}

function signIn(input: {
  env: Record<string, string | undefined>;
  harness: Harness;
  member: string;
  args: readonly string[];
}): number {
  console.log(
    `Signing ${input.member} in to ${input.harness} on this machine. Complete the login below; it stays on this machine.`,
  );
  const { home, exitCode } = signInOnMachine({
    dataDir: dataDir(input.env),
    harness: input.harness,
    member: input.member,
    args: input.args,
  });
  if (exitCode !== 0) {
    console.error(`The ${input.harness} login exited with ${exitCode}.`);
    return exitCode;
  }
  console.log(
    `Done. ${input.member}'s ${input.harness} sign-in is in ${home}. A running worker reports it within seconds.`,
  );
  return 0;
}

function dataDir(env: Record<string, string | undefined>): string {
  return env.WORK_DATA_DIR ?? "/data";
}
