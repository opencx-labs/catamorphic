import { createHash } from "node:crypto";
import { shellQuote } from "@catamorphic/git";
import {
  followProcess,
  type SandboxEgress,
  type SandboxProvider,
} from "@catamorphic/sandbox";
import { SESSION_DIRECTORY } from "./sandbox-git.js";
import { sandboxSecretsPrelude } from "./sandbox-secrets.js";

/*
 * Workspace setup (ADR 0208): an Environment's `setup` command, then the
 * member's own, run in the project folder of each new workspace before its
 * first turn, again when either command changes, and again when the
 * workspace's base moves (ADR 0257). What last succeeded is recorded in the
 * session directory (`setup.done`), beside the project and gone with the
 * sandbox, so a workspace rebuilt after idle release sets up again. Output
 * is appended to `setup.log` there. A setup with its own network runs the
 * Environment's part with the sandbox widened to it, and the member's part
 * once it is narrow again (ADR 0257).
 */

/** The background process a setup runs as, found again by a later preparation. */
export const SETUP_PROCESS_NAME = "Workspace setup";

/** How many lines of the log the agent is shown after a failure. */
export const SETUP_LOG_TAIL_LINES = 60;

const NONE = "none";

/**
 * The session directory from the project folder, where every setup command
 * runs: commands name sandbox paths relative to it, since only a command's
 * folder is resolved for them on every provider.
 */
const SESSION_FROM_PROJECT = `../${SESSION_DIRECTORY}`;

/**
 * The commands a workspace last set up with, by fingerprint, and the base
 * commit it set up on (ADR 0178), or `none`.
 */
export interface SetupRecord {
  environment: string;
  personal: string;
  base: string;
}

const NOTHING_RECORDED: SetupRecord = {
  environment: NONE,
  personal: NONE,
  base: NONE,
};

/** One part of a workspace's setup. */
export type SetupPart = "environment" | "personal";

/** A command's fingerprint, or `none` without one. */
export function setupFingerprint(command: string | undefined): string {
  return command?.trim()
    ? `sha256:${createHash("sha256").update(command).digest("hex")}`
    : NONE;
}

/** `setup.done` as written by {@link workspaceSetupScript}; null otherwise. */
export function parseSetupRecord(text: string): SetupRecord | null {
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value === "object" &&
      value !== null &&
      "environment" in value &&
      "personal" in value &&
      "base" in value &&
      typeof value.environment === "string" &&
      typeof value.personal === "string" &&
      typeof value.base === "string"
    )
      return {
        environment: value.environment,
        personal: value.personal,
        base: value.base,
      };
  } catch {
    // Missing, partial or edited by hand: set up again.
  }
  return null;
}

/** What one preparation runs, and what it records once that succeeds. */
export interface WorkspaceSetupPlan {
  record: SetupRecord;
  environment?: string;
  personal?: string;
}

/**
 * Whether the Environment's part runs (again): its command changed, or
 * the workspace's base moved since it ran (ADR 0257), as a review chat's
 * workspace does on every push.
 */
export function environmentSetupDue(input: {
  environment?: string;
  base?: string;
  recorded: SetupRecord | null;
}): boolean {
  const recorded = input.recorded ?? NOTHING_RECORDED;
  return (
    setupFingerprint(input.environment) !== recorded.environment ||
    (input.base ?? NONE) !== recorded.base
  );
}

/**
 * What runs now, or null when the workspace already set up with these
 * commands on this base. The Environment's part runs when its command
 * changed or the base moved; the owner's when theirs changed, or after the
 * Environment's runs. A turn that may not run the member's own setup
 * (another person wrote it, or the placement may not hold personal
 * credentials) keeps what an earlier turn's did, so it never runs the
 * Environment's setup again just for that.
 */
export function planWorkspaceSetup(input: {
  environment?: string;
  personal?: string;
  /** The owner's personal setup may run in this turn. */
  personalAllowed: boolean;
  /** The workspace's base commit, when it stands on one (ADR 0178). */
  base?: string;
  recorded: SetupRecord | null;
}): WorkspaceSetupPlan | null {
  const environment = input.environment?.trim() ? input.environment : undefined;
  const personal =
    input.personalAllowed && input.personal?.trim()
      ? input.personal
      : undefined;
  const recorded = input.recorded ?? NOTHING_RECORDED;
  const record: SetupRecord = {
    environment: setupFingerprint(environment),
    personal: input.personalAllowed
      ? setupFingerprint(personal)
      : recorded.personal,
    base: input.base ?? NONE,
  };
  const environmentDue = environmentSetupDue({
    ...(environment ? { environment } : {}),
    ...(input.base ? { base: input.base } : {}),
    recorded,
  });
  const personalDue =
    input.personalAllowed &&
    (environmentDue || record.personal !== recorded.personal);
  if (!environmentDue && !personalDue) return null;
  return {
    record,
    ...(environmentDue && environment ? { environment } : {}),
    ...(personalDue && personal ? { personal } : {}),
  };
}

/** The parts a plan runs, in order. */
export function planParts(plan: WorkspaceSetupPlan): SetupPart[] {
  return [
    ...(plan.environment ? ["environment" as const] : []),
    ...(plan.personal ? ["personal" as const] : []),
  ];
}

/**
 * What `setup.done` says once `part` succeeded. After the Environment's
 * part, an owner's part still to run is recorded as not run, so its
 * failure runs only it again.
 */
export function setupRecordAfter(input: {
  plan: WorkspaceSetupPlan;
  part: SetupPart;
}): SetupRecord {
  return input.part === "environment" && input.plan.personal
    ? { ...input.plan.record, personal: NONE }
    : input.plan.record;
}

const PART_LABELS: Record<SetupPart, string> = {
  environment: "Environment setup",
  personal: "Personal setup",
};

/**
 * The script one setup runs from the project folder (POSIX shell, run
 * with bash): output appended to the log, the session's secrets loaded
 * when present (ADR 0206), then each of `parts` (the plan's, by default)
 * with `bash -e` so its first failing command stops it, the record written
 * after each part that succeeded.
 */
export function workspaceSetupScript(input: {
  plan: WorkspaceSetupPlan;
  parts?: readonly SetupPart[];
}): string {
  const { plan } = input;
  const parts = planParts(plan).filter(
    (part) => !input.parts || input.parts.includes(part),
  );
  const stale = [
    ...(plan.environment ? [] : ["environment.sh"]),
    ...(plan.personal ? [] : ["personal.sh"]),
  ];
  const writeRecord = (record: SetupRecord) => [
    `printf '%s\\n' ${shellQuote(JSON.stringify(record))} > "$work_session/setup.done.next"`,
    'mv -f "$work_session/setup.done.next" "$work_session/setup.done"',
  ];
  return [
    `mkdir -p ${SESSION_FROM_PROJECT}`,
    `work_session=$(cd ${SESSION_FROM_PROJECT} && pwd -P) || exit 1`,
    'exec >>"$work_session/setup.log" 2>&1',
    ...stale.map((file) => `rm -f "$work_session/setup/${file}"`),
    `printf '\\n== Workspace setup started %s ==\\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')"`,
    // The Environment's secrets (ADR 0206) and the gateway's variables
    // (ADR 0212), from the project folder where the script starts.
    sandboxSecretsPrelude(),
    "work_part() {",
    "  printf '\\n-- %s\\n' \"$1\"",
    '  bash -e "$2"',
    "  work_status=$?",
    '  if [ "$work_status" -ne 0 ]; then',
    '    printf \'\\n== %s failed with exit code %s ==\\n\' "$1" "$work_status"',
    '    exit "$work_status"',
    "  fi",
    "}",
    ...(parts.length === 0
      ? writeRecord(plan.record)
      : parts.flatMap((part) => [
          `work_part ${shellQuote(PART_LABELS[part])} "$work_session/setup/${part}.sh"`,
          ...writeRecord(setupRecordAfter({ plan, part })),
        ])),
    `printf '\\n== Workspace setup finished %s ==\\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')"`,
    "",
  ].join("\n");
}

export type WorkspaceSetupOutcome =
  /** Nothing to run: no setup, or this one already ran here. */
  | { status: "current" }
  | { status: "succeeded" }
  | {
      status: "failed";
      exitCode: number | null;
      timedOut: boolean;
      /** The end of the log. */
      log: string;
      /** Which parts ran. */
      parts: SetupPart[];
    }
  /** The turn stopped while setup ran; it was stopped too. */
  | { status: "aborted" };

/** The session directory of a provider's sandboxes. */
export function sessionDirectory(provider: SandboxProvider): string {
  return `${provider.workspaceRoot}/${SESSION_DIRECTORY}`;
}

/** What a sandbox workspace last set up with; null when nothing is recorded. */
export async function readSetupRecord(input: {
  provider: SandboxProvider;
  sandboxId: string;
  projectDir: string;
}): Promise<SetupRecord | null> {
  const read = await input.provider.executeCommand(
    input.sandboxId,
    `cat ${shellQuote(`${SESSION_FROM_PROJECT}/setup.done`)} 2>/dev/null || true`,
    { cwd: input.projectDir, timeout: 60 },
  );
  return parseSetupRecord(read.result.trim());
}

/**
 * A sandbox could not be switched to its Environment's own network, so it
 * was stopped (ADR 0257). The preparation fails rather than let an agent
 * work in a sandbox that may still reach the setup's hosts.
 */
export class SetupNetworkError extends Error {
  constructor(args: { cause: unknown }) {
    super(
      `The workspace could not be switched back to its Environment's network, so it was stopped: ${args.cause instanceof Error ? args.cause.message : String(args.cause)}`,
    );
    this.name = "SetupNetworkError";
  }
}

/**
 * Switch a sandbox to its Environment's own egress (ADR 0257), closing
 * every connection open through it. A sandbox that cannot be switched is
 * stopped, and {@link SetupNetworkError} thrown: fail closed.
 */
export async function narrowSandboxEgress(input: {
  provider: SandboxProvider;
  sandboxId: string;
  egress: SandboxEgress;
}): Promise<void> {
  try {
    if (!input.provider.setEgress)
      throw new Error("This machine cannot switch a sandbox's network");
    await input.provider.setEgress({
      sandboxId: input.sandboxId,
      egress: input.egress,
    });
  } catch (error) {
    await input.provider.stopSandbox(input.sandboxId).catch(() => {});
    throw new SetupNetworkError({ cause: error });
  }
}

/**
 * Run `run` with the sandbox on the setup's network (ADR 0257), then
 * narrow it again once `run` ended however it ended, its process exited
 * or killed. Narrowing that fails stops the sandbox and throws, whatever
 * `run` did.
 */
async function onSetupNetwork<T>(input: {
  provider: SandboxProvider;
  sandboxId: string;
  network: { setup: SandboxEgress; own: SandboxEgress };
  run: () => Promise<T>;
}): Promise<T> {
  try {
    if (!input.provider.setEgress)
      throw new Error(
        "This machine cannot switch a sandbox's network, so the setup's network cannot be given",
      );
    await input.provider.setEgress({
      sandboxId: input.sandboxId,
      egress: input.network.setup,
    });
    return await input.run();
  } finally {
    await narrowSandboxEgress({
      provider: input.provider,
      sandboxId: input.sandboxId,
      egress: input.network.own,
    });
  }
}

/**
 * Set up one workspace if it needs it (ADR 0208). A setup an earlier,
 * interrupted preparation started is waited for rather than started again,
 * and never on a wider network than the sandbox has. `onRun` is called
 * just before commands run, so the chat can show it.
 */
export async function runWorkspaceSetup(input: {
  provider: SandboxProvider;
  sandboxId: string;
  projectDir: string;
  environment?: string;
  personal?: string;
  personalAllowed: boolean;
  /** The workspace's base commit, when it stands on one (ADR 0178). */
  base?: string;
  timeoutMinutes: number;
  /**
   * The setup's own network (ADR 0257): the Environment's part runs with
   * the sandbox switched to `setup`, then it is switched back to `own`
   * before anything else runs. Given only for a sandbox this preparation
   * created, in which nothing has run.
   */
  network?: { setup: SandboxEgress; own: SandboxEgress };
  signal?: AbortSignal;
  onRun?: () => Promise<void>;
}): Promise<WorkspaceSetupOutcome> {
  const { provider, sandboxId, projectDir } = input;
  const personal = input.personalAllowed ? input.personal : undefined;
  if (!input.environment?.trim() && !personal?.trim())
    return { status: "current" };
  const session = SESSION_FROM_PROJECT;
  const timeoutMs = input.timeoutMinutes * 60_000;
  const processes = provider.processes;
  const running = processes
    ? (await processes.listProcesses({ sandboxId })).find(
        (process) =>
          process.name === SETUP_PROCESS_NAME && process.status === "running",
      )
    : undefined;
  if (processes && running) {
    await input.onRun?.();
    const earlier = await followProcess({
      processes,
      sandboxId,
      processId: running.processId,
      cursor: running.outputBytes,
      timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (earlier.aborted) return { status: "aborted" };
    if (earlier.timedOut)
      await processes
        .signalProcess({
          sandboxId,
          processId: running.processId,
          signal: "SIGKILL",
        })
        .catch(() => {});
  }
  const plan = planWorkspaceSetup({
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.personal ? { personal: input.personal } : {}),
    personalAllowed: input.personalAllowed,
    ...(input.base ? { base: input.base } : {}),
    recorded: await readSetupRecord({ provider, sandboxId, projectDir }),
  });
  if (!plan) return { status: "current" };
  const parts = planParts(plan);
  if (parts.length > 0) await input.onRun?.();
  // Only the Environment's part runs on the setup's network, and never a
  // part that follows what an earlier preparation started (ADR 0257).
  const network =
    input.network && plan.environment && !running ? input.network : undefined;
  const phases: Array<{ script: string; parts: SetupPart[] }> = network
    ? [
        { script: "environment.run.sh", parts: ["environment"] },
        ...(plan.personal
          ? [{ script: "personal.run.sh", parts: ["personal" as const] }]
          : []),
      ]
    : [{ script: "run.sh", parts }];
  await provider.uploadFiles(
    sandboxId,
    {
      ...Object.fromEntries(
        phases.map((phase) => [
          phase.script,
          workspaceSetupScript({ plan, parts: phase.parts }),
        ]),
      ),
      ...(plan.environment
        ? { "environment.sh": `${plan.environment}\n` }
        : {}),
      ...(plan.personal ? { "personal.sh": `${plan.personal}\n` } : {}),
    },
    `${sessionDirectory(provider)}/setup`,
  );
  const deadline = Date.now() + timeoutMs;
  const ran: SetupPart[] = [];
  for (const phase of phases) {
    ran.push(...phase.parts);
    const run = () =>
      runSetupCommand({
        provider,
        sandboxId,
        projectDir,
        command: `bash ${shellQuote(`${session}/setup/${phase.script}`)}`,
        timeoutMs: Math.max(0, deadline - Date.now()),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    const result =
      network && phase.parts.includes("environment")
        ? await onSetupNetwork({ provider, sandboxId, network, run })
        : await run();
    if (result === "aborted") return { status: "aborted" };
    const { exitCode, timedOut } = result;
    if (exitCode === 0 && !timedOut) continue;
    const tail = await provider
      .executeCommand(
        sandboxId,
        `tail -n ${SETUP_LOG_TAIL_LINES} ${shellQuote(`${session}/setup.log`)} 2>/dev/null || true`,
        { cwd: projectDir, timeout: 60 },
      )
      .then(
        (result) => result.result,
        () => "",
      );
    return { status: "failed", exitCode, timedOut, log: tail, parts: ran };
  }
  return { status: "succeeded" };
}

/**
 * Run one setup script: as a background process followed for the setup's
 * own budget (a command budget the Environment sets for agents does not
 * apply), stopped on timeout or when the turn stops; in the foreground
 * where the provider has no background processes.
 */
async function runSetupCommand(input: {
  provider: SandboxProvider;
  sandboxId: string;
  projectDir: string;
  command: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ exitCode: number | null; timedOut: boolean } | "aborted"> {
  const { provider, sandboxId } = input;
  const processes = provider.processes;
  if (!processes) {
    const result = await provider.executeCommand(sandboxId, input.command, {
      cwd: input.projectDir,
      timeout: Math.max(1, Math.ceil(input.timeoutMs / 1000)),
    });
    return input.signal?.aborted
      ? "aborted"
      : { exitCode: result.exitCode, timedOut: false };
  }
  const started = await processes.startProcess({
    sandboxId,
    command: input.command,
    cwd: input.projectDir,
    name: SETUP_PROCESS_NAME,
  });
  const followed = await followProcess({
    processes,
    sandboxId,
    processId: started.processId,
    cursor: 0,
    timeoutMs: input.timeoutMs,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (followed.aborted || followed.timedOut)
    await processes
      .signalProcess({
        sandboxId,
        processId: started.processId,
        signal: "SIGKILL",
      })
      .catch(() => {});
  if (followed.aborted) return "aborted";
  return { exitCode: followed.exitCode, timedOut: followed.timedOut };
}

/**
 * What the agent is told when its workspace's setup failed (ADR 0208): what
 * failed, the end of the log, and that it runs again before the next turn.
 */
export function workspaceSetupFailedNote(input: {
  outcome: Extract<WorkspaceSetupOutcome, { status: "failed" }>;
  timeoutMinutes: number;
  logPath: string;
}): string {
  const { outcome } = input;
  const what = outcome.timedOut
    ? `did not finish within ${input.timeoutMinutes} ${input.timeoutMinutes === 1 ? "minute" : "minutes"} and was stopped`
    : outcome.exitCode === null
      ? "was stopped"
      : `failed with exit code ${outcome.exitCode}`;
  const where = [
    ...(outcome.parts.includes("environment")
      ? [
          "the Environment's `setup` in .work/project.json (a reviewed project change)",
        ]
      : []),
    ...(outcome.parts.includes("personal")
      ? [
          "the person's own `setup` in .work/personal/environment.json on their computer",
        ]
      : []),
  ];
  const log = outcome.log.trimEnd().slice(-8_000);
  const commands =
    where.length === 0
      ? ""
      : ` ${where.length === 1 ? "The command is" : "The commands are"} ${where.join(" and ")}.`;
  return [
    `[Workspace] Setting up this workspace ${what}, so what it installs may be missing. It runs again before the next turn.${commands}`,
    log
      ? `The end of ${input.logPath}:\n\n\`\`\`\n${log}\n\`\`\``
      : `Its output is in ${input.logPath}.`,
  ].join("\n\n");
}

/**
 * What the agent is told when its Environment's setup asks for a network of
 * its own in a folder on a person's computer, which has none to switch
 * (ADR 0257).
 */
export function workspaceSetupNetworkRefusedNote(): string {
  return "[Workspace] The Environment's setup did not run here: it names a network of its own (`setup.network` in .work/project.json), which only a sandbox can switch to while it runs, and this chat works in a folder on this computer. Run the chat in a sandbox Environment, or remove `setup.network`.";
}

/**
 * What the agent is told when its workspace's setup could not run at all,
 * such as when the sandbox did not answer (ADR 0208).
 */
export function workspaceSetupUnavailableNote(input: {
  reason: string;
}): string {
  return `[Workspace] Setting up this workspace could not run (${input.reason.slice(0, 500)}), so what it installs may be missing. It runs again before the next turn.`;
}
