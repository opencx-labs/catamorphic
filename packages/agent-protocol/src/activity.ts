import type { Item } from "./model.js";

/**
 * The live line for an item a harness is working on: the step's own
 * description where the harness gave one (what its row says), else a calm
 * verb, never a raw command, a tool's technical name or the prose being
 * written (that belongs to the message). Undefined for items that say
 * nothing live.
 */
export function itemActivity(item: Item): string | undefined {
  switch (item.kind) {
    case "file_change":
      return "Editing files...";
    case "command":
      return described(item.description) ?? commandActivity(item.command);
    case "tool_call":
      return described(item.description) ?? "Working...";
    case "subagent":
      return item.status === "in_progress"
        ? item.title
          ? `Delegating: ${item.title}`
          : "Delegating to a subagent..."
        : "Subagent finished...";
    case "reasoning":
      return "Thinking...";
    case "assistant_message":
      return "Writing...";
    default:
      return undefined;
  }
}

/** How long a live line may be; the UI shows one line of it. */
export const ACTIVITY_MAX = 200;

/**
 * Text as a live line: one line, cut at a word past `max` (with an
 * ellipsis), or undefined when it says nothing.
 */
export function activityLine(
  text: string | null | undefined,
  max = ACTIVITY_MAX,
): string | undefined {
  const line = text?.replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  if (line.length <= max) return line;
  const cut = line.lastIndexOf(" ", max - 1);
  return `${line.slice(0, cut > max / 2 ? cut : max - 1)}…`;
}

/**
 * A step's description as its live line: a harness's own short words for
 * the call (Claude Code's "Read the VAD options"). A long or multi-line
 * one is a tool's data (an issue's body), never the line.
 */
function described(text: string | null): string | undefined {
  if (!text || text.trim().includes("\n") || text.length > 120)
    return undefined;
  return activityLine(text);
}

/** Friendly verbs for well-known programs; anything else is "Working...". */
const COMMAND_LABELS: Record<string, string> = {
  sleep: "Waiting...",
  find: "Searching files...",
  grep: "Searching files...",
  rg: "Searching files...",
  ag: "Searching files...",
  ls: "Looking around...",
  tree: "Looking around...",
  pwd: "Looking around...",
  cat: "Reading files...",
  head: "Reading files...",
  tail: "Reading files...",
  wc: "Reading files...",
  mkdir: "Creating files...",
  touch: "Creating files...",
  cp: "Copying files...",
  mv: "Moving files...",
  git: "Working with git...",
  curl: "Fetching a URL...",
  wget: "Fetching a URL...",
  make: "Building...",
  cargo: "Building...",
  tsc: "Building...",
  npm: "Running scripts...",
  npx: "Running scripts...",
  pnpm: "Running scripts...",
  yarn: "Running scripts...",
  bun: "Running scripts...",
  bunx: "Running scripts...",
  node: "Running code...",
  python: "Running code...",
  python3: "Running code...",
  vitest: "Running tests...",
  jest: "Running tests...",
  pytest: "Running tests...",
};

/**
 * The first program of the first pipeline segment, skipping environment
 * assignments and trivial wrappers, named by what it does.
 */
export function commandActivity(command: string | undefined): string {
  if (!command) return "Working...";
  const segment = command.split(/\s*(?:&&|\|\||[;|])\s*/, 1)[0] ?? "";
  let program: string | undefined;
  for (const word of segment.trim().split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    if (word === "env" || word === "sudo" || word === "command") continue;
    program = word.split("/").pop();
    break;
  }
  return (program && COMMAND_LABELS[program]) ?? "Working...";
}
