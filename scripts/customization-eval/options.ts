import path from "node:path";
import type { AgentEffort } from "../../packages/agent-protocol/src/model.js";

export type EvalHarness = "codex" | "claude-code" | "builtin";
export interface EvalOptions {
  live: boolean;
  list: boolean;
  harness: EvalHarness;
  scenario: string;
  model?: string;
  effort?: AgentEffort;
  provider: "openai" | "anthropic" | "openrouter";
  timeoutMs: number;
  runs: number;
  output: string;
  authHome?: string;
  command?: string;
}

export function parseOptions({
  args,
  cwd,
}: {
  args: readonly string[];
  cwd: string;
}): EvalOptions {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const names = new Set([
    "harness",
    "scenario",
    "model",
    "effort",
    "provider",
    "timeout",
    "runs",
    "output",
    "auth-home",
    "command",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--live" || arg === "--list") {
      switches.add(arg);
      continue;
    }
    const name = arg?.slice(2);
    const value = args[index + 1];
    if (!arg?.startsWith("--") || !name || !names.has(name))
      throw new Error(`Unknown argument: ${arg ?? ""}`);
    if (!value || value.startsWith("--"))
      throw new Error(`${arg} requires a value`);
    if (values.has(name)) throw new Error(`${arg} was supplied twice`);
    values.set(name, value);
    index += 1;
  }
  const harness = values.get("harness") ?? "codex";
  if (harness !== "codex" && harness !== "claude-code" && harness !== "builtin")
    throw new Error("--harness must be codex, claude-code, or builtin");
  const effort = values.get("effort");
  if (
    effort !== undefined &&
    effort !== "low" &&
    effort !== "medium" &&
    effort !== "high" &&
    effort !== "xhigh" &&
    effort !== "max"
  )
    throw new Error("--effort must be low, medium, high, xhigh, or max");
  const provider = values.get("provider") ?? "openai";
  if (
    provider !== "openai" &&
    provider !== "anthropic" &&
    provider !== "openrouter"
  )
    throw new Error("--provider must be openai, anthropic, or openrouter");
  const integer = (name: string, fallback: number, max: number) => {
    const value = Number(values.get(name) ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new Error(`--${name} must be an integer from 1 to ${max}`);
    return value;
  };
  const model = values.get("model");
  if (harness === "builtin" && !model && !switches.has("--list"))
    throw new Error("The builtin harness requires --model");
  const stamp = new Date().toISOString().replaceAll(":", "-");
  return {
    live: switches.has("--live"),
    list: switches.has("--list"),
    harness,
    scenario: values.get("scenario") ?? "todo-sidebar",
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    provider,
    timeoutMs: integer("timeout", 600, 3_600) * 1_000,
    runs: integer("runs", 1, 20),
    output: path.resolve(
      cwd,
      values.get("output") ?? `test-results/customization-evals/${stamp}`,
    ),
    ...(values.get("auth-home")
      ? { authHome: path.resolve(cwd, values.get("auth-home") ?? "") }
      : {}),
    ...(values.get("command") ? { command: values.get("command") } : {}),
  };
}
