import type { AgentCommand } from "../../shared/agent-commands.js";
import { commandScore } from "./command-score";
import { type SkillInfo, skillInvocation } from "./skills";

export interface SlashEntry {
  name: string;
  title: string;
  description: string;
  source: string;
  argumentHint: string;
  kind: "status" | "skill" | "command";
  skillPath?: string;
}

/** First declaration wins: desktop actions, shared skills, then native commands. */
export function slashEntries({
  skills,
  commands,
  harnessLabel,
}: {
  skills: SkillInfo[];
  commands: AgentCommand[];
  harnessLabel: string;
}): SlashEntry[] {
  const entries: SlashEntry[] = [
    {
      name: "status",
      title: "Session status",
      description: "Show this session's status and actions",
      source: "Desktop",
      argumentHint: "",
      kind: "status",
    },
  ];
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
      argumentHint: "[instructions]",
    });
  for (const command of commands)
    entries.push({
      ...command,
      title: command.name,
      source: harnessLabel,
      kind: command.skillPath ? "skill" : "command",
    });
  const unique = new Map<string, SlashEntry>();
  for (const entry of entries) {
    if (entry.name && !/\s/.test(entry.name) && !unique.has(entry.name))
      unique.set(entry.name, entry);
  }
  return [...unique.values()];
}

export function matchSlashEntries(
  entries: SlashEntry[],
  query: string,
): SlashEntry[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return entries;
  return entries
    .map((entry) => ({
      entry,
      score:
        entry.name.toLowerCase() === normalized
          ? 3
          : entry.name.toLowerCase().startsWith(normalized)
            ? 2
            : Math.max(
                commandScore(entry.name, normalized),
                commandScore(entry.title, normalized),
                // Descriptions support discovery, but scattered letters across
                // a paragraph must not manufacture an unrelated command match.
                entry.description.toLowerCase().includes(normalized) ? 0.5 : 0,
              ),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ entry }) => entry);
}

export function resolveSlashMessage(
  message: string,
  entries: SlashEntry[],
): string {
  const match = /^\/([^\s\uFFFC]+)([\s\S]*)$/.exec(message);
  const entry = entries.find((candidate) => candidate.name === match?.[1]);
  if (entry?.kind !== "skill") return message;
  if (entry.skillPath) {
    const args = match?.[2]?.trim();
    return `Use the "${entry.name}" skill at ${JSON.stringify(entry.skillPath)}.${args ? ` ${args}` : ""}`;
  }
  return skillInvocation(entry.name, match?.[2]);
}
