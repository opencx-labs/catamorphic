import fs from "node:fs";
import path from "node:path";
import type {
  HookCallback,
  HookCallbackMatcher,
} from "@anthropic-ai/claude-agent-sdk";

/** Claude Code's file tools and the input fields naming their paths. */
const FILE_TOOLS: Record<string, { fields: string[]; writes: boolean }> = {
  Read: { fields: ["file_path"], writes: false },
  Glob: { fields: ["path"], writes: false },
  Grep: { fields: ["path"], writes: false },
  Write: { fields: ["file_path"], writes: true },
  Edit: { fields: ["file_path"], writes: true },
  MultiEdit: { fields: ["file_path"], writes: true },
  NotebookEdit: { fields: ["notebook_path"], writes: true },
};

/**
 * Where the CLI's file tools may reach when its commands run apart (ADR
 * 0332): the checkout is the pull request's, so a link in it could lead a
 * read to the agent's own files (its model grant, its settings) and an
 * edit through it to rewrite them. Every path is resolved to the real file
 * it names first. Writes stay in the checkout and the CLI's temporary
 * folder; reads may also reach the trusted program copy beside the agent.
 */
export function checkoutPathHooks(input: {
  workingDirectory: string;
  temporaryFolder: string;
  /** Read-only places beside the checkout (the `$WORK_PROGRAM` copy). */
  readOnly: readonly string[];
}): HookCallbackMatcher[] {
  const writable = [input.workingDirectory, input.temporaryFolder];
  const readable = [...writable, ...input.readOnly];
  const hook: HookCallback = async (hookInput) => {
    const tool = String(Reflect.get(hookInput, "tool_name") ?? "");
    const spec = FILE_TOOLS[tool];
    const toolInput = Reflect.get(hookInput, "tool_input");
    if (!spec || typeof toolInput !== "object" || toolInput === null) return {};
    for (const field of spec.fields) {
      const value = Reflect.get(toolInput, field);
      if (value === undefined && field === "path") continue;
      if (typeof value !== "string" || !value) continue;
      const target = realPath(path.resolve(input.workingDirectory, value));
      const roots = (spec.writes ? writable : readable).map(realPath);
      if (!roots.some((root) => within(target, root)))
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `${value} is ${target === path.resolve(input.workingDirectory, value) ? "outside" : `a link to ${target}, outside`} the checkout this agent works in. Its commands run apart from it, so its file tools reach only the checkout${spec.writes ? "" : " and its trusted program copy"}.`,
          },
        };
    }
    return {};
  };
  return [{ matcher: Object.keys(FILE_TOOLS).join("|"), hooks: [hook] }];
}

/** The real path a path names, through every link, for one that may not exist yet. */
function realPath(target: string): string {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...missing.reverse());
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function within(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}
