import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CanUseTool,
  McpSdkServerConfigWithInstance,
  McpServerConfig,
  OnElicitation,
  Options,
  PermissionMode,
  SessionStore,
} from "@anthropic-ai/claude-agent-sdk";
import type { JsonObject, JsonValue } from "@catamorphic/agent-protocol";
import type {
  AttemptStart,
  McpServerSpec,
} from "@catamorphic/agent-protocol/runner";
import { hostToolServer } from "./host-tools.js";

/**
 * The adapter settings a host configures per agent, read from
 * `AttemptStart.options` (the adapter itself is built once, with none).
 */
export interface ClaudeCodeAttemptOptions {
  /**
   * The Claude Code CLI to run. Defaults to `claude` on the PATH, except
   * with the host's own model access, where the SDK's bundled CLI runs.
   */
  command?: string;
  /** JS runtime for a script CLI; the SDK detects it when omitted. */
  executable?: "bun" | "deno" | "node";
  executableArgs?: string[];
  /**
   * Claude Code auto-memory (its memory directory and MEMORY.md). On by
   * default, the CLI's own behavior; false sets the CLI's kill switch.
   */
  memory?: boolean;
  /** Host session watchers replace Claude Code's private Monitor tasks. */
  disableNativeMonitors?: boolean;
  /** The shared host todo list replaces TodoWrite. */
  hostOwnsTodos?: boolean;
  /** Work subsessions replace Claude Code's private subagents. */
  hostOwnsSubagents?: boolean;
  /**
   * The host runs background commands that outlive a turn, so Claude
   * Code's native backgrounding (which lives inside the turn's CLI
   * process) is switched off and its follow and stop tools removed.
   */
  hostOwnsBackground?: boolean;
  /** Permission mode when the attempt's permissions name none. */
  permissionMode?: PermissionMode;
}

const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
];

function isPermissionMode(
  value: JsonValue | undefined,
): value is PermissionMode {
  return PERMISSION_MODES.some((mode) => mode === value);
}

function bool(options: JsonObject, key: string): boolean | undefined {
  const value = options[key];
  return typeof value === "boolean" ? value : undefined;
}

/** `AttemptStart.options`, read defensively: unknown keys are ignored. */
export function readAttemptOptions(
  options: JsonObject,
): ClaudeCodeAttemptOptions {
  const command = options.command;
  const executable = options.executable;
  const executableArgs = options.executableArgs;
  const permissionMode = options.permissionMode;
  const flags = {
    memory: bool(options, "memory"),
    disableNativeMonitors: bool(options, "disableNativeMonitors"),
    hostOwnsTodos: bool(options, "hostOwnsTodos"),
    hostOwnsSubagents: bool(options, "hostOwnsSubagents"),
    hostOwnsBackground: bool(options, "hostOwnsBackground"),
  };
  return {
    ...(typeof command === "string" && command ? { command } : {}),
    ...(executable === "bun" || executable === "deno" || executable === "node"
      ? { executable }
      : {}),
    ...(Array.isArray(executableArgs)
      ? {
          executableArgs: executableArgs.filter(
            (arg): arg is string => typeof arg === "string",
          ),
        }
      : {}),
    ...Object.fromEntries(
      Object.entries(flags).filter(([, value]) => value !== undefined),
    ),
    ...(isPermissionMode(permissionMode) ? { permissionMode } : {}),
  };
}

/** Claude Code's own background-task follow and stop tools, both generations. */
const NATIVE_BACKGROUND_TOOLS = [
  "TaskOutput",
  "TaskStop",
  "BashOutput",
  "KillShell",
];

/**
 * Built-in tools that run without asking. Everything else reaches
 * `canUseTool`, which decides it (unlisted tools are denied: Work runs
 * unattended, so nobody would answer a CLI prompt). AskUserQuestion is
 * deliberately absent: its permission check is how its answers arrive.
 */
export const ALLOWED_TOOLS = [
  "Bash",
  "PowerShell",
  "Monitor",
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "WebSearch",
  "WebFetch",
  "TodoWrite",
  "NotebookEdit",
  // Plugins ship skills and slash commands; the tools that invoke them
  // must be callable or the plugin content is unreachable.
  "Skill",
  "SlashCommand",
  // The subagent tool: "Task" in older CLIs, "Agent" since 2.1.
  "Task",
  "Agent",
  ...NATIVE_BACKGROUND_TOOLS,
];

const SHELL_TOOLS = ["Bash", "PowerShell"];

/** Tools that change files: surfaced as `file_change` items. */
export const FILE_EDIT_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

/** Both generations of the subagent tool's name. */
export const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

/** How often the CLI re-reads its gateway key: grants renew every 20 minutes. */
const API_KEY_HELPER_TTL_MS = 5 * 60_000;

/**
 * Variables a sandboxed CLI keeps from the runner's own environment: what
 * a process needs to find programs and a home, never a credential.
 */
const PROCESS_BASICS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
];

function processEnv(keys?: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    if (keys && !keys.includes(key)) continue;
    env[key] = value;
  }
  return env;
}

/** Credentials the CLI takes over the person's sign-in, unasked. */
const INHERITED_CREDENTIALS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

/**
 * The host's environment for a CLI that runs on it, less an inherited
 * Anthropic credential. The SDK runs the CLI in print mode, where it takes
 * an ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) over the person's sign-in
 * without the approval its terminal asks for, so one exported in the shell
 * the host was started from would bill their chats to the API instead of
 * their plan. One for an endpoint Claude Code is routed to (a gateway, set
 * in the host's or the attempt's env or in Claude's settings) stays: the
 * sign-in is not for it. A host that means a key passes it in `env`. The
 * CLI hands its environment to what it runs (Bash commands, hooks, MCP
 * servers), so those do not see the dropped credential either.
 */
export function hostProcessEnv(
  input: {
    /** What the host adds over its environment (the attempt's env). */
    env?: Record<string, string>;
    /** Where the CLI runs: its project settings may route it elsewhere. */
    workingDirectory?: string;
  } = {},
): Record<string, string> {
  const env = processEnv();
  const routed = { ...env, ...input.env };
  if (
    routesToAnthropic(
      claudeBaseUrl({ env: routed, workingDirectory: input.workingDirectory }),
    )
  )
    for (const name of INHERITED_CREDENTIALS) delete env[name];
  return env;
}

/**
 * Where the CLI sends model calls: the `env` of its settings (managed over
 * local over project over user, as the CLI applies them) over its own
 * environment. Local settings are the repository's: from a worktree, the
 * main checkout's, where the git-ignored file lives.
 */
function claudeBaseUrl(input: {
  env: Record<string, string>;
  workingDirectory?: string;
}): string | undefined {
  const userDirectory =
    input.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const directory = input.workingDirectory;
  const root = directory ? repositoryRoot(directory) : undefined;
  const settingsFiles = [
    ...managedSettingsFiles(),
    ...(root ? [path.join(root, ".claude", "settings.local.json")] : []),
    ...(directory
      ? [
          path.join(directory, ".claude", "settings.local.json"),
          path.join(directory, ".claude", "settings.json"),
        ]
      : []),
    path.join(userDirectory, "settings.json"),
  ];
  for (const file of settingsFiles) {
    const baseUrl = settingsEnv(file).ANTHROPIC_BASE_URL;
    if (typeof baseUrl === "string" && baseUrl) return baseUrl;
  }
  return input.env.ANTHROPIC_BASE_URL;
}

/**
 * The administrator's settings files, strongest first: the drop-ins in
 * `managed-settings.d` (later names win) over `managed-settings.json`.
 * Policy the CLI reads from elsewhere (an MDM profile, the Windows
 * registry, server-managed settings) is not seen here.
 */
function managedSettingsFiles(): string[] {
  const directory =
    process.platform === "darwin"
      ? "/Library/Application Support/ClaudeCode"
      : process.platform === "win32"
        ? "C:\\Program Files\\ClaudeCode"
        : "/etc/claude-code";
  const dropIns = path.join(directory, "managed-settings.d");
  let names: string[] = [];
  try {
    // As the CLI takes them: JSON files (or links to them), no dotfiles.
    names = fs
      .readdirSync(dropIns, { withFileTypes: true })
      .filter(
        (entry) =>
          (entry.isFile() || entry.isSymbolicLink()) &&
          entry.name.endsWith(".json") &&
          !entry.name.startsWith("."),
      )
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    // No drop-ins.
  }
  return [
    ...names.map((name) => path.join(dropIns, name)),
    path.join(directory, "managed-settings.json"),
  ];
}

/**
 * Where the CLI looks for a directory's local settings, close to how it
 * decides: the repository's root, and for a linked worktree its main
 * checkout (whose `.git` names a git directory under the main one's
 * `worktrees`). Like the CLI, none on Windows or for a repository at the
 * home directory; unlike it, the root's owner is not checked.
 */
function repositoryRoot(directory: string): string | undefined {
  if (process.platform === "win32") return undefined;
  for (
    let current = path.resolve(directory);
    ;
    current = path.dirname(current)
  ) {
    const dotGit = path.join(current, ".git");
    let found: fs.Stats | undefined;
    try {
      found = fs.statSync(dotGit);
    } catch {
      // Not here: look further up.
    }
    if (found) {
      const root = found.isDirectory() ? current : mainCheckout(current);
      return root === path.resolve(os.homedir()) ? undefined : root;
    }
    if (path.dirname(current) === current) return undefined;
  }
}

/**
 * The main checkout of a linked worktree whose `.git` file is at
 * `directory`; the directory itself for another `.git` file (a submodule,
 * a separate git directory), which has no `commondir`.
 */
function mainCheckout(directory: string): string {
  try {
    const gitDirectory = /^gitdir:\s*(.+)$/m
      .exec(fs.readFileSync(path.join(directory, ".git"), "utf8"))?.[1]
      ?.trim();
    if (!gitDirectory) return directory;
    const linked = path.resolve(directory, gitDirectory);
    const common = path.resolve(
      linked,
      fs.readFileSync(path.join(linked, "commondir"), "utf8").trim(),
    );
    // A bare repository holds its worktrees' settings itself.
    return path.basename(common) === ".git" ? path.dirname(common) : common;
  } catch {
    return directory;
  }
}

/** A Claude settings file's `env` block; empty when there is none. */
function settingsEnv(file: string): Record<string, unknown> {
  try {
    const settings: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof settings !== "object" || settings === null) return {};
    const env: unknown = Reflect.get(settings, "env");
    return typeof env === "object" && env !== null
      ? Object.fromEntries(Object.entries(env))
      : {};
  } catch {
    return {};
  }
}

function routesToAnthropic(baseUrl: string | undefined): boolean {
  if (!baseUrl) return true;
  try {
    return new URL(baseUrl).hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}

function mapMcpServer(spec: McpServerSpec): McpServerConfig {
  if (spec.transport === "stdio")
    return {
      type: "stdio",
      command: spec.command,
      ...(spec.args ? { args: spec.args } : {}),
      ...(spec.env ? { env: spec.env } : {}),
    };
  return {
    type: spec.transport,
    url: spec.url,
    ...(spec.headers ? { headers: spec.headers } : {}),
  };
}

/** The attempt's permission mode: its own, the agent's default, else acceptEdits. */
export function attemptPermissionMode(input: {
  attempt: AttemptStart;
  options: ClaudeCodeAttemptOptions;
}): PermissionMode {
  const own = input.attempt.permissions.permissionMode;
  return isPermissionMode(own)
    ? own
    : (input.options.permissionMode ?? "acceptEdits");
}

/** Why an attempt cannot start, in words for the person. */
export class ClaudeStartError extends Error {
  override readonly name = "ClaudeStartError";
}

export interface QueryOptionInputs {
  attempt: AttemptStart;
  options: ClaudeCodeAttemptOptions;
  hostServers: Record<string, McpSdkServerConfigWithInstance>;
  canUseTool: CanUseTool;
  onElicitation: OnElicitation;
  hooks: NonNullable<Options["hooks"]>;
  sessionStore: SessionStore;
  abortController: AbortController;
  stderr: (data: string) => void;
}

/** Which native thread the query runs on (ADR 0198). */
function threadOptions(attempt: AttemptStart): Partial<Options> {
  const thread = attempt.thread;
  switch (thread.mode) {
    case "fresh":
      // Work allocates the id, so the native id equals the provider thread's.
      return { sessionId: thread.providerThreadId };
    case "resume":
    case "restore":
      // With a session store the SDK always materializes the stored
      // transcript first, so resuming and restoring are the same call.
      return { resume: thread.nativeRef.id };
    case "fork":
      return {
        resume: thread.source.id,
        forkSession: true,
        ...(thread.throughTurnRef
          ? { resumeSessionAt: thread.throughTurnRef.id }
          : {}),
      };
  }
}

/**
 * The SDK options for one attempt: where the CLI runs and how it reaches
 * its model, which tools it has and which need deciding, its hooks, and
 * the native thread it continues.
 */
export function buildQueryOptions(input: QueryOptionInputs): Options {
  const { attempt, options } = input;
  const access = attempt.modelAccess;
  if (access.kind === "gateway" && access.api !== "anthropic")
    throw new ClaudeStartError(
      `Claude Code speaks the Anthropic API, and this chat's model connection is an ${access.api} API. Bind an Anthropic connection in the agent's Environment.`,
    );
  const hostToolNames = attempt.hostTools.map((tool) => tool.name);
  const hostOwnsBackground =
    options.hostOwnsBackground === true ||
    hostToolNames.includes("run_background_command");
  const hostOwnsTodos =
    options.hostOwnsTodos === true ||
    hostToolNames.includes("update_todo_list");
  const hostOwnsSubagents =
    options.hostOwnsSubagents === true ||
    hostToolNames.includes("spawn_subsession");
  const permissionMode = attemptPermissionMode({ attempt, options });
  const readOnly = permissionMode === "plan";
  const disallowedTools = [
    ...(readOnly ? SHELL_TOOLS : []),
    ...(readOnly ? [...FILE_EDIT_TOOLS] : []),
    ...(hostOwnsBackground ? NATIVE_BACKGROUND_TOOLS : []),
    ...(options.disableNativeMonitors || readOnly ? ["Monitor"] : []),
    ...(hostOwnsTodos ? ["TodoWrite"] : []),
    ...(hostOwnsSubagents ? [...SUBAGENT_TOOLS] : []),
  ];
  const external: Record<string, McpServerConfig> = {};
  for (const [name, spec] of Object.entries(attempt.mcpServers))
    external[name] = mapMcpServer(spec);

  const host = access.kind === "host";
  const env: Record<string, string> = {
    // On the host the CLI inherits the host's environment (its own
    // sign-in and settings) but not a stray API key; beside a sandbox's
    // workspace it gets the process basics and exactly what the attempt
    // lists, so no credential reaches it but the access below.
    ...(host
      ? hostProcessEnv({
          env: attempt.env,
          workingDirectory: attempt.workingDirectory,
        })
      : processEnv(PROCESS_BASICS)),
    ...attempt.env,
    ...(options.memory === false
      ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }
      : {}),
    ...(hostOwnsBackground
      ? { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" }
      : {}),
    ...(host
      ? {}
      : {
          DISABLE_AUTOUPDATER: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          // The CLI refuses to bypass its checks as root outside a
          // sandbox; this is one, and Work governs what leaves it.
          ...(permissionMode === "bypassPermissions"
            ? { IS_SANDBOX: "1" }
            : {}),
        }),
    ...(access.kind === "gateway"
      ? {
          ANTHROPIC_BASE_URL: access.baseUrl,
          WORK_MODEL_KEY_FILE: access.keyFile,
          CLAUDE_CODE_API_KEY_HELPER_TTL_MS: String(API_KEY_HELPER_TTL_MS),
        }
      : {}),
    // The member's own sign-in, in the harness's own home (ADR 0199).
    ...(access.kind === "sign_in" ? { CLAUDE_CONFIG_DIR: access.home } : {}),
  };
  const command = options.command ?? (host ? undefined : "claude");
  const systemPrompt = attempt.systemPrompt.trim();

  return {
    cwd: attempt.workingDirectory,
    // A real Claude Code shell: the CLI's own system prompt, with the
    // host's instructions appended.
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(systemPrompt ? { append: systemPrompt } : {}),
    },
    env,
    ...(command ? { pathToClaudeCodeExecutable: command } : {}),
    ...(options.executable ? { executable: options.executable } : {}),
    ...(options.executableArgs
      ? { executableArgs: options.executableArgs }
      : {}),
    ...(access.kind === "gateway"
      ? {
          // The session's grant, read from its file at each use, so a
          // renewal applies without a restart (ADR 0180).
          settings: { apiKeyHelper: 'cat "$WORK_MODEL_KEY_FILE"' },
        }
      : {}),
    ...(attempt.model ? { model: attempt.model } : {}),
    ...(attempt.effort ? { effort: attempt.effort } : {}),
    permissionMode,
    ...(permissionMode === "bypassPermissions"
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    ...(Object.keys(external).length > 0 ||
    Object.keys(input.hostServers).length > 0
      ? { mcpServers: { ...external, ...input.hostServers } }
      : {}),
    ...(attempt.plugins.length > 0
      ? {
          // Plugin MCP servers are lifted into mcpServers by the host so
          // every harness shares the connections.
          plugins: attempt.plugins.map((plugin) => ({
            type: "local" as const,
            path: plugin.path,
            skipMcpDiscovery: true,
          })),
        }
      : {}),
    allowedTools: [
      ...ALLOWED_TOOLS.filter((name) => !disallowedTools.includes(name)),
      ...attempt.hostTools.map(
        (tool) => `mcp__${hostToolServer(tool)}__${tool.name}`,
      ),
      // A server without a policy is allowed whole; a policed one's tools
      // each reach canUseTool.
      ...Object.keys(external)
        .filter((name) => !attempt.toolPolicies[name])
        .map((name) => `mcp__${name}`),
    ],
    // Removed, not merely denied: a replaced built-in leaves the model's
    // context, so the CLI's prompt cannot steer toward it.
    ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
    canUseTool: input.canUseTool,
    onElicitation: input.onElicitation,
    hooks: input.hooks,
    // Everything real Claude Code recognizes: the repository's CLAUDE.md
    // and .claude, and the harness home's own settings.
    settingSources: ["user", "project", "local"],
    includePartialMessages: true,
    sessionStore: input.sessionStore,
    // Every transcript line reaches Work as it is written, so a lost
    // runner leaves its thread resumable up to its last line.
    sessionStoreFlush: "eager",
    abortController: input.abortController,
    stderr: input.stderr,
    ...threadOptions(attempt),
  };
}
