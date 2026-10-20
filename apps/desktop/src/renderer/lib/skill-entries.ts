import type { AgentCommand } from "../../shared/agent-commands.js";
import { type SkillInfo, skillInvocation } from "./skills";

/**
 * One row of the palette's Skills mode (ADR 0270): the chat's status, a
 * shared skill (project, personal or app), or the chat agent's own command
 * or skill.
 */
export interface SkillEntry {
  name: string;
  title: string;
  description: string;
  source: string;
  /** What the instructions say, e.g. "[issue-number]"; empty for free text. */
  argumentHint: string;
  kind: "status" | "skill" | "command";
  skillPath?: string;
}

/** First declaration wins: Work's status, shared skills, then native commands. */
export function skillEntries({
  skills,
  commands,
  harnessLabel,
  status,
}: {
  skills: SkillInfo[];
  commands: AgentCommand[];
  harnessLabel: string;
  /** A chat is the target, so its status is one of the rows. */
  status: boolean;
}): SkillEntry[] {
  const entries: SkillEntry[] = status
    ? [
        {
          name: "status",
          title: "Status",
          description: "This chat's session details and actions",
          source: "Work",
          argumentHint: "",
          kind: "status",
        },
      ]
    : [];
  for (const skill of skills)
    entries.push({
      name: skill.name,
      title: skill.title,
      description: skill.description,
      source:
        skill.source === "host"
          ? "App skill"
          : skill.source === "user"
            ? "Personal skill"
            : "Project skill",
      kind: "skill",
      argumentHint: skill.argumentHint ?? "",
    });
  for (const command of commands)
    entries.push({
      ...command,
      title: command.skillPath ? command.name : `/${command.name}`,
      source: harnessLabel,
      kind: command.skillPath ? "skill" : "command",
    });
  const unique = new Map<string, SkillEntry>();
  // Status is Work's own row: no skill or native command takes its name.
  for (const entry of entries) {
    if (entry.name && !/\s/.test(entry.name) && !unique.has(entry.name))
      unique.set(entry.name, entry);
  }
  return [...unique.values()];
}

/**
 * The message an entry sends: a shared skill's sentence, a Codex skill's
 * file, or a native command as the harness reads it.
 */
export function entryInvocation(entry: SkillEntry, instructions = ""): string {
  const args = instructions.trim();
  if (entry.kind === "command")
    return args ? `/${entry.name} ${args}` : `/${entry.name}`;
  if (entry.skillPath)
    return `Use the "${entry.name}" skill at ${JSON.stringify(entry.skillPath)}.${args ? ` ${args}` : ""}`;
  return skillInvocation(entry.name, args);
}

const INVOCATION =
  /^Use the "([^"\n]+)" skill(?: at "(?:[^"\\\n]|\\.)*")?(?::|\.)([\s\S]*)$/;

/**
 * A sent invocation read back for the transcript: the skill it names and
 * what came with it (instructions, attachment markers).
 */
export function parseSkillInvocation(
  text: string,
): { name: string; rest: string } | null {
  const match = INVOCATION.exec(text);
  const name = match?.[1];
  if (!name) return null;
  return { name, rest: (match[2] ?? "").trimStart() };
}
