import { createHash } from "node:crypto";
import { shellQuote } from "@catamorphic/git";
import { followProcess, type SandboxProvider } from "@catamorphic/sandbox";
import { SESSION_DIRECTORY } from "./sandbox-git.js";
import { sandboxSecretsPrelude } from "./sandbox-secrets.js";

/*
 * Workspace setup (ADR 0207): an Environment's `setup` command, then the
 * member's own, run in the project folder of each new workspace before its
 * first turn and again when either command changes. What last succeeded is
 * recorded in the session directory (`setup.done`), beside the project and
 * gone with the sandbox, so a workspace rebuilt after idle release sets up
 * again. Output is appended to `setup.log` there.
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

/** The commands a workspace last set up with, by fingerprint. */
export interface SetupRecord {
  environment: string;
  personal: string;
}

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
      typeof value.environment === "string" &&
      typeof value.personal === "string"
    )
      return { environment: value.environment, personal: value.personal };
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
 * What runs now, or null when the workspace already set up with these
 * commands. A turn that may not run the member's own setup (another
 * person wrote it, or the placement may not hold personal credentials)
 * keeps what an earlier turn's did, so it never runs the Environment's
 * setup again just for that.
 */
export function planWorkspaceSetup(input: {
  environment?: string;
  personal?: string;
  /** The owner's personal setup may run in this turn. */
  personalAllowed: boolean;
  recorded: SetupRecord | null;
}): WorkspaceSetupPlan | null {
  const environment = input.environment?.trim() ? input.environment : undefined;
  const personal =
    input.personalAllowed && input.personal?.trim()
      ? input.personal
      : undefined;
  const recorded = input.recorded ?? { environment: NONE, personal: NONE };
  const record: SetupRecord = {
    environment: setupFingerprint(environment),
    personal: input.personalAllowed
      ? setupFingerprint(personal)
      : recorded.personal,
  };
  if (
    record.environment === recorded.environment &&
    record.personal === recorded.personal
  )
    return null;
  return {
    record,
    ...(environment ? { environment } : {}),
    ...(personal ? { personal } : {}),
  };
}

/**
 * The script one setup runs from the project folder (POSIX shell, run
 * with bash): output appended to the log, the session's secrets loaded
 * when present (ADR 0205), then each part with `bash -e` so its first
 * failing command stops it, and the record written only once every part
 * succeeded.
 */
export function workspaceSetupScript(input: {
  plan: WorkspaceSetupPlan;
}): string {
  const { plan } = input;
  const parts = [
    ...(plan.environment ? [["Environment setup", "environment.sh"]] : []),
    ...(plan.personal ? [["Personal setup", "personal.sh"]] : []),
  ];
  const stale = [
    ...(plan.environment ? [] : ["environment.sh"]),
    ...(plan.personal ? [] : ["personal.sh"]),
  ];
  return [
    `mkdir -p ${SESSION_FROM_PROJECT}`,
    `work_session=$(cd ${SESSION_FROM_PROJECT} && pwd -P) || exit 1`,
    'exec >>"$work_session/setup.log" 2>&1',
    ...stale.map((file) => `rm -f "$work_session/setup/${file}"`),
    `printf '\\n== Workspace setup started %s ==\\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')"`,
    // The Environment's secrets (ADR 0205), from the project folder where
    // the script starts.
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
    ...parts.map(
      ([label, file]) =>
        `work_part ${shellQuote(label ?? "")} "$work_session/setup/${file}"`,
    ),
    `printf '%s\\n' ${shellQuote(JSON.stringify(plan.record))} > "$work_session/setup.done.next"`,
    'mv -f "$work_session/setup.done.next" "$work_session/setup.done"',
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
      parts: Array<"environment" | "personal">;
    }
  /** The turn stopped while setup ran; it was stopped too. */
  | { status: "aborted" };

/** The session directory of a provider's sandboxes. */
export function sessionDirectory(provider: SandboxProvider): string {
  return `${provider.workspaceRoot}/${SESSION_DIRECTORY}`;
}

/**
 * Set up one workspace if it needs it (ADR 0207). A setup an earlier,
 * interrupted preparation started is waited for rather than started again.
 * `onRun` is called just before commands run, so the chat can show it.
 */
export async function runWorkspaceSetup(input: {
  provider: SandboxProvider;
  sandboxId: string;
  projectDir: string;
  environment?: string;
  personal?: string;
  personalAllowed: boolean;
  timeoutMinutes: number;
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
  if (processes) {
    const running = (await processes.listProcesses({ sandboxId })).find(
      (process) =>
        process.name === SETUP_PROCESS_NAME && process.status === "running",
    );
    if (running) {
      await input.onRun?.();
      const followed = await followProcess({
        processes,
        sandboxId,
        processId: running.processId,
        cursor: running.outputBytes,
        timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (followed.aborted) return { status: "aborted" };
      if (followed.timedOut)
        await processes
          .signalProcess({
            sandboxId,
            processId: running.processId,
            signal: "SIGKILL",
          })
          .catch(() => {});
    }
  }
  const read = await provider.executeCommand(
    sandboxId,
    `cat ${shellQuote(`${session}/setup.done`)} 2>/dev/null || true`,
    { cwd: projectDir, timeout: 60 },
  );
  const plan = planWorkspaceSetup({
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.personal ? { personal: input.personal } : {}),
    personalAllowed: input.personalAllowed,
    recorded: parseSetupRecord(read.result.trim()),
  });
  if (!plan) return { status: "current" };
  const parts: Array<"environment" | "personal"> = [
    ...(plan.environment ? ["environment" as const] : []),
    ...(plan.personal ? ["personal" as const] : []),
  ];
  if (parts.length > 0) await input.onRun?.();
  await provider.uploadFiles(
    sandboxId,
    {
      "run.sh": workspaceSetupScript({ plan }),
      ...(plan.environment
        ? { "environment.sh": `${plan.environment}\n` }
        : {}),
      ...(plan.personal ? { "personal.sh": `${plan.personal}\n` } : {}),
    },
    `${sessionDirectory(provider)}/setup`,
  );
  const ran = await runSetupCommand({
    provider,
    sandboxId,
    projectDir,
    command: `bash ${shellQuote(`${session}/setup/run.sh`)}`,
    timeoutMinutes: input.timeoutMinutes,
    ...(input.signal ? { signal: input.signal } : {}),
  });
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
 * Run the setup script: as a background process followed for the setup's
 * own budget (a command budget the Environment sets for agents does not
 * apply), stopped on timeout or when the turn stops; in the foreground
 * where the provider has no background processes.
 */
async function runSetupCommand(input: {
  provider: SandboxProvider;
  sandboxId: string;
  projectDir: string;
  command: string;
  timeoutMinutes: number;
  signal?: AbortSignal;
}): Promise<{ exitCode: number | null; timedOut: boolean } | "aborted"> {
  const { provider, sandboxId } = input;
  const processes = provider.processes;
  if (!processes) {
    const result = await provider.executeCommand(sandboxId, input.command, {
      cwd: input.projectDir,
      timeout: input.timeoutMinutes * 60,
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
    timeoutMs: input.timeoutMinutes * 60_000,
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
 * What the agent is told when its workspace's setup failed (ADR 0207): what
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
 * What the agent is told when its workspace's setup could not run at all,
 * such as when the sandbox did not answer (ADR 0207).
 */
export function workspaceSetupUnavailableNote(input: {
  reason: string;
}): string {
  return `[Workspace] Setting up this workspace could not run (${input.reason.slice(0, 500)}), so what it installs may be missing. It runs again before the next turn.`;
}
