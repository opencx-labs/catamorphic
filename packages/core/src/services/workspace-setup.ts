import { createHash, randomUUID } from "node:crypto";
import { shellQuote } from "@catamorphic/git";
import {
  followProcess,
  type SandboxEgress,
  type SandboxProvider,
} from "@catamorphic/sandbox";
import { SESSION_DIRECTORY } from "./sandbox-git.js";
import { sandboxSecretsPrelude } from "./sandbox-secrets.js";
import { type PhaseTimer, UNTIMED } from "./sessions/attempt-phases.js";
import { WORKSPACE_SETUP_EVENT as SETUP_EVENT_KIND } from "./workspace-events.js";

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
 * What `setup.done` says of an Environment's part while the runs of its
 * setup event (ADR 0355) have not ended: its command ran, and it is not
 * done until they are.
 */
const PENDING = "pending";

/**
 * What `setup.done` says of an Environment that names no command, once the
 * runs of its setup event set the workspace up (ADR 0355).
 */
const HOOKED = "hook";

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

/**
 * One part of a workspace's setup: the Environment's command, the runs of
 * its setup event (`hook`, ADR 0355), the member's own command.
 */
export type SetupPart = "environment" | "hook" | "personal";

/**
 * Why a setup runs, as its event (ADR 0355) and its commands (ADR 0354)
 * say it: the workspace is new (`created`), was made again (`rebuilt`),
 * stands on another base (`base-moved`), or its setup changed (`changed`).
 */
export type SetupReason = "created" | "rebuilt" | "base-moved" | "changed";

/**
 * The sandbox a setup's event is about (ADR 0355): one this preparation
 * made (`new`), or one the chat already used (`kept`).
 */
export type SetupSandbox = "new" | "kept";

/** Why a setup runs, and the base this sandbox last set up on, if any. */
export interface SetupCause {
  reason: SetupReason;
  previousBase?: string;
}

/** The variables a setup's commands read (ADR 0354). */
export const SETUP_VARIABLES = {
  base: "WORK_BASE",
  previousBase: "WORK_PREVIOUS_BASE",
  reason: "WORK_SETUP_REASON",
} as const;

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
  /** The setup's event is recorded after `environment`, and waited for (ADR 0355). */
  hook?: true;
  personal?: string;
}

/**
 * Whether the Environment's part runs (again): its command changed, or
 * the workspace's base moved since it ran (ADR 0257), as a review chat's
 * workspace does on every push. An Environment with no command is done
 * whether or not its setup event's runs set it up (ADR 0355), so one that
 * gains or loses a listener sets nothing up again by that alone.
 */
export function environmentSetupDue(input: {
  environment?: string;
  base?: string;
  recorded: SetupRecord | null;
}): boolean {
  const recorded = input.recorded ?? NOTHING_RECORDED;
  const fingerprint = setupFingerprint(input.environment);
  const done = fingerprint === NONE ? [NONE, HOOKED] : [fingerprint];
  return (
    !done.includes(recorded.environment) ||
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
 *
 * With `hook`, a project automation listens for this setup's event (ADR
 * 0355): the event follows the Environment's command. With `kept` as well,
 * the sandbox is one the chat already used and set up, so the command does
 * not run by itself: what happens there is the listening workflow's to say.
 */
export function planWorkspaceSetup(input: {
  environment?: string;
  /** A project automation listens for this setup's event (ADR 0355). */
  hook?: boolean;
  /** The sandbox stays as it is: its Environment's command does not run. */
  kept?: boolean;
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
  const hook = environmentDue && input.hook === true;
  const record: SetupRecord = {
    // What is recorded stays while this part is not due: an Environment
    // with no command keeps whether its event's runs set it up.
    environment: !environmentDue
      ? recorded.environment
      : environment
        ? setupFingerprint(environment)
        : hook
          ? HOOKED
          : NONE,
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
    ...(environmentDue && environment && !(hook && input.kept)
      ? { environment }
      : {}),
    ...(hook ? { hook: true as const } : {}),
    ...(personalDue && personal ? { personal } : {}),
  };
}

/**
 * How long a session's turn waits for another session's setup of the same
 * workspace build (ADR 0322) before it gives up. Each part a setup may run
 * is bounded by the setup's timeout: following a setup an earlier holder
 * left running, the Environment's command, the runs of its setup event
 * (ADR 0355) and the owner's personal setup; five minutes more cover the
 * preparation around them. A command on its own network (ADR 0257) is the
 * same command, not another part.
 */
export function setupClaimWaitMs(input: {
  timeoutMinutes: number;
  command?: string;
  /** A project automation is bound to the setup's event. */
  hook?: boolean;
  personalAllowed: boolean;
}): number {
  const parts =
    1 +
    (input.command?.trim() ? 1 : 0) +
    (input.hook ? 1 : 0) +
    (input.personalAllowed ? 1 : 0);
  return (input.timeoutMinutes * parts + 5) * 60_000;
}

/**
 * Why `plan` runs (ADR 0354), from what the sandbox recorded. It is about
 * the Environment's part when that runs, else the owner's own. With that
 * part not set up here yet (nothing recorded, or an earlier try that did
 * not finish), the reason is why the workspace is new, and there is no
 * earlier base; otherwise it is what changed since, and the base is the
 * one its last setup here ran on.
 */
export function setupCause(input: {
  plan: WorkspaceSetupPlan;
  recorded: SetupRecord | null;
  /** The sandbox replaced an earlier workspace of the chat. */
  rebuilt: boolean;
  /** This preparation moved the workspace's base. */
  moved: boolean;
}): SetupCause {
  const { plan, recorded } = input;
  const done = !recorded
    ? NONE
    : plan.environment || plan.hook
      ? recorded.environment
      : recorded.personal;
  if (!recorded || done === NONE || done === PENDING)
    return {
      reason: input.moved
        ? "base-moved"
        : input.rebuilt
          ? "rebuilt"
          : "created",
    };
  return {
    reason: recorded.base !== plan.record.base ? "base-moved" : "changed",
    ...(recorded.base !== NONE ? { previousBase: recorded.base } : {}),
  };
}

/**
 * What a setup's commands are told (ADR 0354), by variable: the commit the
 * workspace stands on, the one this sandbox's last setup ran on, and why
 * this one runs. One with no value is unset for them.
 */
export function setupVariables(input: {
  plan: WorkspaceSetupPlan;
  cause: SetupCause;
}): Record<string, string | undefined> {
  const { base } = input.plan.record;
  return {
    [SETUP_VARIABLES.base]: base === NONE ? undefined : base,
    [SETUP_VARIABLES.previousBase]: input.cause.previousBase,
    [SETUP_VARIABLES.reason]: input.cause.reason,
  };
}

/**
 * Why a sandbox's Environment setup is due (ADR 0355), from what it
 * recorded: what its event says and its commands hear, known before
 * anything runs, so who listens can be asked first. Null when it already
 * ran here with this command on this base.
 */
export function environmentSetupCause(input: {
  environment?: string;
  base?: string;
  recorded: SetupRecord | null;
  rebuilt: boolean;
  moved: boolean;
}): SetupCause | null {
  const plan = planWorkspaceSetup({
    ...(input.environment ? { environment: input.environment } : {}),
    hook: true,
    personalAllowed: false,
    ...(input.base ? { base: input.base } : {}),
    recorded: input.recorded,
  });
  return plan?.hook
    ? setupCause({
        plan,
        recorded: input.recorded,
        rebuilt: input.rebuilt,
        moved: input.moved,
      })
    : null;
}

/** The parts a plan runs, in order. */
export function planParts(plan: WorkspaceSetupPlan): SetupPart[] {
  return [
    ...(plan.environment ? ["environment" as const] : []),
    ...(plan.hook ? ["hook" as const] : []),
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
  // A command its setup event follows is not done until its runs are.
  if (input.part === "environment" && input.plan.hook)
    return { ...input.plan.record, environment: PENDING, personal: NONE };
  return input.part === "personal"
    ? input.plan.record
    : { ...input.plan.record, personal: NONE };
}

const PART_LABELS: Record<SetupPart, string> = {
  environment: "Environment setup",
  hook: "Setup workflows",
  personal: "Personal setup",
};

/**
 * The script one setup runs from the project folder (POSIX shell, run
 * with bash): output appended to the log, the session's secrets loaded
 * when present (ADR 0206) unless `loadSecrets` is false, what the commands
 * run on and why exported (ADR 0354), then each of `parts` (the plan's, by
 * default) with `bash -e` so its first failing command stops it, the
 * record written after each part that succeeded.
 */
export function workspaceSetupScript(input: {
  plan: WorkspaceSetupPlan;
  cause: SetupCause;
  parts?: readonly SetupPart[];
  loadSecrets?: boolean;
}): string {
  const { plan } = input;
  const parts = planParts(plan).filter(
    (part) => part !== "hook" && (!input.parts || input.parts.includes(part)),
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
    ...Object.entries(setupVariables(input)).map(([name, value]) =>
      value === undefined
        ? `unset ${name}`
        : `export ${name}=${shellQuote(value)}`,
    ),
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
      /** The runs of the setup's event failed (ADR 0355); `log` says how. */
      hook?: true;
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
 * How the runs of a setup's event ended (ADR 0355). `sandboxId` names the
 * sandbox they left the chat with, when one of them asked for the setup's
 * network in a kept sandbox and it was replaced.
 */
export type SetupHookOutcome =
  | { status: "succeeded"; sandboxId?: string }
  | { status: "failed"; error: string; timedOut: boolean }
  | { status: "aborted" };

/** A setup's event, for one preparation whose project automations listen. */
export interface SetupHook {
  /**
   * The sandbox is one the chat already used and set up (ADR 0355): the
   * Environment's command does not run by itself.
   */
  kept: boolean;
  /** Record the event and wait for the runs it starts. */
  run: (args: { cause: SetupCause }) => Promise<SetupHookOutcome>;
}

/**
 * Set up one workspace if it needs it (ADR 0208). A setup an earlier,
 * interrupted preparation started is waited for rather than started again.
 * `onRun` is called just before commands run, so the chat can show it.
 * With `hook`, a project automation listens for the setup's event (ADR
 * 0355): it is recorded after the Environment's command, through
 * `hook.run`, and waited for before the owner's part; the record says the
 * Environment's part is done only once those runs succeeded. `"under-way"`
 * says the event's runs are waiting for this very command (they asked for
 * the setup's network in a kept sandbox): it runs alone, recorded as not
 * done until they are.
 *
 * With `network` (ADR 0257), only the Environment's part runs, on the
 * setup's network, in a sandbox this preparation made that holds the base
 * checkout alone: it loads no secrets file, and has only `network.env`
 * (the secrets the setup names). Its event's runs run narrow; their
 * commands `in: "setup"` widen the sandbox for themselves. The owner's
 * part is a later call's.
 *
 * Each command hears what it runs on and why (ADR 0354): `WORK_BASE`,
 * `WORK_PREVIOUS_BASE` when this sandbox set up before, and
 * `WORK_SETUP_REASON`, the reason the event says. Each command runs as a
 * script of its own and is timed as a phase of the attempt, with `phases`.
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
  /**
   * Run the Environment's part alone, before the chat's grants, secrets
   * and files are in the sandbox (ADR 0324): no secrets file, only `env`
   * (the secrets the setup names), on the sandbox's own network.
   */
  isolated?: { env: Record<string, string> };
  /** The sandbox replaced an earlier workspace of the chat. */
  rebuilt?: boolean;
  /** This preparation moved the workspace's base. */
  moved?: boolean;
  /** The setup's event, when a project automation listens (ADR 0355). */
  hook?: SetupHook | "under-way";
  /** Times each command as a phase of the attempt it prepares (ADR 0354). */
  phases?: PhaseTimer;
  signal?: AbortSignal;
  onRun?: () => Promise<void>;
}): Promise<WorkspaceSetupOutcome> {
  const { provider, sandboxId, projectDir, network } = input;
  const alone = Boolean(network || input.isolated);
  const env = network?.env ?? input.isolated?.env;
  const personal = input.personalAllowed && !alone ? input.personal : undefined;
  const hook = input.hook === "under-way" ? undefined : input.hook;
  if (!input.environment?.trim() && !personal?.trim() && !input.hook)
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
  const recorded = await readSetupRecord({ provider, sandboxId, projectDir });
  const plan = planWorkspaceSetup({
    ...(input.environment ? { environment: input.environment } : {}),
    hook: input.hook !== undefined,
    kept: hook?.kept === true,
    ...(personal ? { personal } : {}),
    personalAllowed: input.personalAllowed && !alone,
    ...(input.base ? { base: input.base } : {}),
    recorded,
  });
  if (!plan) return { status: "current" };
  const parts = planParts(plan);
  const cause = setupCause({
    plan,
    recorded,
    rebuilt: input.rebuilt === true,
    moved: input.moved === true,
  });
  const phases = input.phases ?? UNTIMED;
  if (parts.length > 0) await input.onRun?.();
  await provider.uploadFiles(
    sandboxId,
    {
      ...(plan.environment
        ? { "environment.sh": `${plan.environment}\n` }
        : {}),
      ...(plan.personal ? { "personal.sh": `${plan.personal}\n` } : {}),
    },
    `${sessionDirectory(provider)}/setup`,
  );
  const failed = async (ran: {
    exitCode: number | null;
    timedOut: boolean;
  }): Promise<WorkspaceSetupOutcome> => {
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
    return { status: "failed", ...ran, log: tail, parts };
  };
  /** One script running `only` of the plan's shell parts. */
  const script = async (only: readonly ("environment" | "personal")[]) => {
    await provider.uploadFiles(
      sandboxId,
      {
        "run.sh": workspaceSetupScript({
          plan,
          cause,
          parts: only,
          ...(alone ? { loadSecrets: false } : {}),
        }),
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
        ...(env ? { env } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    return network && only.includes("environment")
      ? onSetupNetwork({
          provider,
          sandboxId,
          egress: network.egress,
          until: new Date(Date.now() + timeoutMs + WIDENING_GRACE_MS),
          run,
        })
      : run();
  };
  /** One shell part, timed; what the setup came to when it did not succeed. */
  const part = async (
    name: "environment" | "personal",
  ): Promise<WorkspaceSetupOutcome | undefined> => {
    const ran = await phases.run(`setup.${name}`, () => script([name]));
    if (ran === "aborted") return { status: "aborted" };
    return ran.exitCode === 0 && !ran.timedOut ? undefined : failed(ran);
  };
  // Nothing to run: what the workspace stands on is recorded.
  if (parts.length === 0) {
    const ran = await script([]);
    if (ran === "aborted") return { status: "aborted" };
    return ran.exitCode === 0 && !ran.timedOut
      ? { status: "succeeded" }
      : failed(ran);
  }
  // The command, then its event's runs, then the owner's part (ADR 0355).
  if (plan.environment) {
    const stopped = await part("environment");
    if (stopped) return stopped;
  }
  if (plan.hook && hook) {
    const ended = await hook.run({ cause });
    if (ended.status === "aborted") return { status: "aborted" };
    if (ended.status === "failed")
      return {
        status: "failed",
        exitCode: null,
        timedOut: ended.timedOut,
        log: ended.error,
        parts,
        hook: true,
      };
    const done = plan.personal
      ? setupRecordAfter({ plan, part: "hook" })
      : plan.record;
    // In the sandbox its runs left the chat with: a kept one they asked to
    // have replaced holds no record yet.
    await provider.executeCommand(
      ended.sandboxId ?? sandboxId,
      [
        `mkdir -p ${SESSION_FROM_PROJECT}`,
        `printf '%s\\n' ${shellQuote(JSON.stringify(done))} > ${shellQuote(`${SESSION_FROM_PROJECT}/setup.done.next`)}`,
        `mv -f ${shellQuote(`${SESSION_FROM_PROJECT}/setup.done.next`)} ${shellQuote(`${SESSION_FROM_PROJECT}/setup.done`)}`,
      ].join(" && "),
      { cwd: projectDir, timeout: 60 },
    );
  }
  if (plan.personal) {
    const stopped = await part("personal");
    if (stopped) return stopped;
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
    ...(outcome.parts.includes("environment") || outcome.parts.includes("hook")
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
  // What failed is the event's runs, not a command: their error, not the
  // log's end (ADR 0355).
  if (outcome.hook)
    return [
      `[Workspace] Setting up this workspace ${outcome.timedOut ? `did not finish within ${input.timeoutMinutes} ${input.timeoutMinutes === 1 ? "minute" : "minutes"}: the project's setup workflows (bound to the \`${SETUP_EVENT_KIND}\` trigger) were stopped` : `failed in the project's setup workflows (bound to the \`${SETUP_EVENT_KIND}\` trigger)`}, so what they prepare may be missing. They run again before the next turn.`,
      ...(log ? [`What failed:\n\n\`\`\`\n${log}\n\`\`\``] : []),
    ].join("\n\n");
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
  /** A sandbox holding its owner's sign-in from its start. */
  | "sign-in"
  /** A workspace admitted before the Environment named a setup network. */
  | "not-admitted";

const REFUSALS: Record<SetupNetworkRefusal, string> = {
  folder:
    "this chat works in a folder on this computer, and only a sandbox can switch its network while setup runs",
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
