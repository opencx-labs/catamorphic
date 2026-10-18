import { createHash, randomUUID } from "node:crypto";
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
 * is appended to `setup.log` there. A setup with its own network (ADR 0257)
 * runs the Environment's part alone, on that network, before anything but
 * the base checkout is in the sandbox; the member's part runs later, once
 * the sandbox is narrow and holds the session's work.
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
 * Environment's setup again just for that, unless the Environment's ran:
 * then the owner's is recorded as not run, for their next turn.
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
  const environmentDue = environmentSetupDue({
    ...(environment ? { environment } : {}),
    ...(input.base ? { base: input.base } : {}),
    recorded,
  });
  const record: SetupRecord = {
    environment: setupFingerprint(environment),
    personal: input.personalAllowed
      ? setupFingerprint(personal)
      : environmentDue
        ? NONE
        : recorded.personal,
    base: input.base ?? NONE,
  };
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
 * part, the owner's is recorded as not run, whether or not it runs next,
 * so their own setup runs again on what the Environment's set up.
 */
export function setupRecordAfter(input: {
  plan: WorkspaceSetupPlan;
  part: SetupPart;
}): SetupRecord {
  return input.part === "environment"
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
 * when present (ADR 0206) unless `loadSecrets` is false, then each of
 * `parts` (the plan's, by default) with `bash -e` so its first failing
 * command stops it, the record written after each part that succeeded.
 */
export function workspaceSetupScript(input: {
  plan: WorkspaceSetupPlan;
  parts?: readonly SetupPart[];
  loadSecrets?: boolean;
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
    ...(input.loadSecrets === false ? [] : [sandboxSecretsPrelude()]),
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
 * A sandbox could not be returned to its Environment's own network, so it
 * was stopped (ADR 0257). The preparation fails rather than let an agent
 * work in a sandbox that may still reach the setup's hosts.
 */
export class SetupNetworkError extends Error {
  constructor(args: { cause: unknown }) {
    super(
      `The workspace could not be returned to its Environment's network, so it was stopped: ${args.cause instanceof Error ? args.cause.message : String(args.cause)}`,
    );
    this.name = "SetupNetworkError";
  }
}

/**
 * Return a sandbox to its own egress (ADR 0257), closing every connection
 * open through it, and end the widening `id`. A sandbox that cannot be
 * narrowed is stopped, and {@link SetupNetworkError} thrown: fail closed.
 */
export async function narrowSandboxEgress(input: {
  provider: SandboxProvider;
  sandboxId: string;
  id: string;
}): Promise<void> {
  try {
    if (!input.provider.narrowEgress)
      throw new Error("This machine cannot narrow a sandbox's network");
    await input.provider.narrowEgress({
      sandboxId: input.sandboxId,
      id: input.id,
    });
  } catch (error) {
    await input.provider.stopSandbox(input.sandboxId).catch(() => {});
    throw new SetupNetworkError({ cause: error });
  }
}

/** How long past its own timeout a setup's network may stay wide. */
const WIDENING_GRACE_MS = 60_000;

/**
 * Run `run` with the sandbox on the setup's network (ADR 0257), then
 * narrow it again once `run` ended however it ended, its process exited
 * or killed. The machine narrows by itself at `until` should this never
 * happen, and refuses the widening should it arrive after its narrowing.
 * Narrowing that fails stops the sandbox and throws, whatever `run` did.
 */
async function onSetupNetwork<T>(input: {
  provider: SandboxProvider;
  sandboxId: string;
  egress: SandboxEgress;
  until: Date;
  run: () => Promise<T>;
}): Promise<T> {
  const id = randomUUID();
  try {
    if (!input.provider.widenEgress)
      throw new Error(
        "This machine cannot widen a sandbox's network, so the setup's network cannot be given",
      );
    await input.provider.widenEgress({
      sandboxId: input.sandboxId,
      egress: input.egress,
      id,
      until: input.until.toISOString(),
    });
    return await input.run();
  } finally {
    await narrowSandboxEgress({
      provider: input.provider,
      sandboxId: input.sandboxId,
      id,
    });
  }
}

/**
 * Set up one workspace if it needs it (ADR 0208). A setup an earlier,
 * interrupted preparation started is waited for rather than started again.
 * `onRun` is called just before commands run, so the chat can show it.
 *
 * With `network` (ADR 0257), only the Environment's part runs, on the
 * setup's network, in a sandbox this preparation made that holds the base
 * checkout alone: it loads no secrets file, and has only `network.env`
 * (the secrets the setup names). The owner's part is a later call's.
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
  network?: { egress: SandboxEgress; env: Record<string, string> };
  signal?: AbortSignal;
  onRun?: () => Promise<void>;
}): Promise<WorkspaceSetupOutcome> {
  const { provider, sandboxId, projectDir, network } = input;
  const personal =
    input.personalAllowed && !network ? input.personal : undefined;
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
  // Nothing ran in a sandbox a setup may widen (ADR 0257).
  if (running && network)
    throw new Error(
      "A setup is already running in a sandbox that was to be set up on its own network",
    );
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
    ...(personal ? { personal } : {}),
    personalAllowed: input.personalAllowed && !network,
    ...(input.base ? { base: input.base } : {}),
    recorded: await readSetupRecord({ provider, sandboxId, projectDir }),
  });
  if (!plan) return { status: "current" };
  const parts = planParts(plan);
  if (parts.length > 0) await input.onRun?.();
  await provider.uploadFiles(
    sandboxId,
    {
      "run.sh": workspaceSetupScript({
        plan,
        ...(network ? { loadSecrets: false } : {}),
      }),
      ...(plan.environment
        ? { "environment.sh": `${plan.environment}\n` }
        : {}),
      ...(plan.personal ? { "personal.sh": `${plan.personal}\n` } : {}),
    },
    `${sessionDirectory(provider)}/setup`,
  );
  const run = () =>
    runSetupCommand({
      provider,
      sandboxId,
      projectDir,
      command: `bash ${shellQuote(`${session}/setup/run.sh`)}`,
      timeoutMs,
      ...(network ? { env: network.env } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  const ran =
    network && plan.environment
      ? await onSetupNetwork({
          provider,
          sandboxId,
          egress: network.egress,
          until: new Date(Date.now() + timeoutMs + WIDENING_GRACE_MS),
          run,
        })
      : await run();
  if (ran === "aborted") return { status: "aborted" };
  const { exitCode, timedOut } = ran;
  if (exitCode === 0 && !timedOut) return { status: "succeeded" };
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
  return { status: "failed", exitCode, timedOut, log: tail, parts };
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
  env?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<{ exitCode: number | null; timedOut: boolean } | "aborted"> {
  const { provider, sandboxId } = input;
  const processes = provider.processes;
  if (!processes) {
    const result = await provider.executeCommand(sandboxId, input.command, {
      cwd: input.projectDir,
      timeout: Math.max(1, Math.ceil(input.timeoutMs / 1000)),
      ...(input.env ? { env: input.env } : {}),
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
    ...(input.env ? { env: input.env } : {}),
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

/** Why an Environment's setup with its own network did not run (ADR 0257). */
export type SetupNetworkRefusal =
  /** A chat's folder on a person's computer, which has no network to switch. */
  | "folder"
  /** A workspace that does not start from a commit of the project's remote. */
  | "no-base"
  /** A sandbox holding its owner's sign-in from its start. */
  | "sign-in"
  /** A workspace admitted before the Environment named a setup network. */
  | "not-admitted";

const REFUSALS: Record<SetupNetworkRefusal, string> = {
  folder:
    "this chat works in a folder on this computer, and only a sandbox can switch its network while setup runs",
  "no-base":
    "this chat's workspace does not start from a commit of the project's remote (a delivery's `workspace: { ref }`), so there is no checkout free of earlier work to run it in",
  "sign-in":
    "this chat's sandbox holds its owner's sign-in from the start, which the setup's hosts could receive",
  "not-admitted":
    "this chat's workspace was admitted before the Environment named it; it runs once the workspace is made again",
};

/**
 * What the agent is told when its Environment's setup names a network of
 * its own and could not run with it (ADR 0257).
 */
export function workspaceSetupNetworkRefusedNote(input: {
  reason: SetupNetworkRefusal;
}): string {
  return `[Workspace] The Environment's setup did not run: it names a network of its own (\`setup.network\` in .work/project.json), and ${REFUSALS[input.reason]}. What it installs may be missing.`;
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
