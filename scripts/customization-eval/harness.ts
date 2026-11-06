import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { buildAiSdkAdapter } from "../../apps/desktop/src/main/server/coding-agent.js";
import type {
  HarnessAdapter,
  ModelAccess,
} from "../../packages/agent-protocol/src/runner.js";
import { shellSingleQuote } from "../../packages/agent-protocol/src/runner.js";
import type { AiSdkLocal } from "../../packages/ai-sdk/src/index.js";
import { createClaudeCodeAdapter } from "../../packages/claude-code/src/index.js";
import { createCodexAdapter } from "../../packages/codex/src/index.js";
import { pinnedCodexCommand } from "../../packages/codex/src/testing/pinned.js";
import { LocalProcessSandboxProvider } from "../../packages/local-process/src/index.js";
import { confinedAgentCommand } from "./confinement.js";
import type { EvalOptions } from "./options.js";

export interface EvalAgent {
  adapter: HarnessAdapter;
  project: string;
  modelAccess: ModelAccess;
  env: Record<string, string>;
  adapterOptions: { [key: string]: string | boolean };
  local?: AiSdkLocal;
  close: () => Promise<void>;
}

/** Individual auth files only. Original settings and native thread stores stay untouched. */
export async function stageSignIn(input: {
  harness: "codex" | "claude-code";
  source: string;
}): Promise<{ directory: string; close: () => Promise<void> }> {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "work-eval-auth-")),
  );
  await chmod(directory, 0o700);
  const file = input.harness === "codex" ? "auth.json" : ".credentials.json";
  try {
    await copyFile(path.join(input.source, file), path.join(directory, file));
    await chmod(path.join(directory, file), 0o600);
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new Error(
      `No ${input.harness} sign-in file in ${input.source}. Supply --auth-home; authentication is never copied into retained reports.`,
    );
  }
  return {
    directory,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

/** The evaluation reuses Work's actual adapters, not a second CLI implementation. */
export async function createEvalAgent(input: {
  options: EvalOptions;
  directory: string;
}): Promise<EvalAgent> {
  const { options, directory } = input;
  const home = path.join(directory, "profile", "home");
  const temp = path.join(directory, "profile", "tmp");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(temp, { recursive: true }),
  ]);
  // Codex transport merges env over its parent. Blank inherited values first,
  // so provider keys and personal Work settings never reach agent commands.
  const env = {
    ...Object.fromEntries(Object.keys(process.env).map((key) => [key, ""])),
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: temp,
    LANG: "en_US.UTF-8",
    SHELL: "/bin/sh",
    BUN_INSTALL_CACHE_DIR: path.join(directory, "profile", "bun-cache"),
  };
  if (options.harness === "builtin") {
    const keyName =
      options.provider === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : options.provider === "openrouter"
          ? "OPENROUTER_API_KEY"
          : "OPENAI_API_KEY";
    const apiKey = process.env[keyName];
    if (!apiKey || !options.model)
      throw new Error(`builtin requires ${keyName} and --model`);
    const adapter = buildAiSdkAdapter({
      config: {
        apiKey,
        provider: options.provider,
        effort: options.effort ?? "medium",
      },
      modelId: options.model,
    });
    if (!adapter)
      throw new Error("The builtin provider could not be configured");
    const sandboxRoot = path.join(directory, "profile", "sandboxes");
    const provider = new LocalProcessSandboxProvider({
      root: sandboxRoot,
      env: { PATH: env.PATH },
    });
    const sandbox = await provider.createSandbox({});
    const project = path.join(sandboxRoot, sandbox.id, "workspace");
    const shell = await confinedAgentCommand({
      command: "/bin/sh",
      bun: process.execPath,
      project,
      profile: path.join(directory, "profile"),
      auth: home,
    });
    const wrap = (command: string) =>
      `${shellSingleQuote(shell)} -c ${shellSingleQuote(command)}`;
    const constrained = {
      uploadFiles: provider.uploadFiles.bind(provider),
      downloadFile: provider.downloadFile.bind(provider),
      executeCommand: (...args: Parameters<typeof provider.executeCommand>) =>
        provider.executeCommand(args[0], wrap(args[1]), args[2]),
      processes: {
        ...provider.processes,
        startProcess: (
          args: Parameters<typeof provider.processes.startProcess>[0],
        ) =>
          provider.processes.startProcess({
            ...args,
            command: wrap(args.command),
          }),
      },
    };
    return {
      adapter,
      project,
      modelAccess: { kind: "host" },
      env,
      adapterOptions: {},
      local: {
        sandbox: {
          provider: constrained,
          sandboxId: sandbox.id,
          workingDirectory: "/workspace",
          commandBudgetSeconds: 60,
        },
      },
      // Retain generated source; stop every process without destroying its workspace.
      close: async () => {
        for (const process of await provider.processes.listProcesses({
          sandboxId: sandbox.id,
        }))
          await provider.processes.signalProcess({
            sandboxId: sandbox.id,
            processId: process.processId,
            signal: "SIGTERM",
          });
      },
    };
  }
  const harness = options.harness;
  const source =
    options.authHome ??
    path.join(homedir(), harness === "codex" ? ".codex" : ".claude");
  const auth = await stageSignIn({ harness, source });
  const project = path.join(directory, "project");
  let command: string;
  try {
    command = await confinedAgentCommand({
      command:
        options.command ??
        (harness === "codex" ? pinnedCodexCommand() : "claude"),
      project,
      profile: path.join(directory, "profile"),
      auth: auth.directory,
      bun: process.execPath,
    });
  } catch (error) {
    await auth.close();
    throw error;
  }
  return {
    adapter:
      harness === "codex" ? createCodexAdapter() : createClaudeCodeAdapter(),
    project,
    modelAccess: { kind: "sign_in", home: auth.directory },
    env,
    adapterOptions:
      harness === "codex"
        ? {
            command,
            disableNativeSubagents: true,
            disableNativeGoals: true,
          }
        : {
            command,
            memory: false,
            hostOwnsSubagents: true,
            disableNativeMonitors: true,
          },
    close: auth.close,
  };
}
