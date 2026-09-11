import { describe, expect, it } from "vitest";
import { skillsForAgent } from "./skills";
import {
  matchSlashEntries,
  resolveSlashMessage,
  slashEntries,
} from "./slash-commands";

const skills = [
  {
    name: "team-notes",
    title: "Meeting notes",
    description: "Write clear minutes",
    source: "project" as const,
    path: ".agents/skills/team-notes/SKILL.md",
  },
];
const entries = slashEntries({
  skills,
  commands: [
    {
      name: "compact",
      description: "Summarize",
      argumentHint: "[instructions]",
    },
    {
      name: "plugin:check",
      description: "Check the release",
      argumentHint: "<release>",
    },
    {
      name: "native-notes",
      description: "Native skill",
      argumentHint: "",
      skillPath: "/tmp/my skills/SKILL.md",
    },
  ],
  harnessLabel: "Native",
});

describe("slash command resolution", () => {
  it("offers only the agent's picked skills across both launchers", () => {
    expect(skillsForAgent(skills, { mode: "picked", names: [] })).toEqual([]);
    expect(
      skillsForAgent(skills, { mode: "picked", names: ["team-notes"] }),
    ).toEqual(skills);
    expect(skillsForAgent(skills, { mode: "all" })).toEqual(skills);
  });
  it("reserves desktop names and deduplicates skills and native commands", () => {
    const result = slashEntries({
      skills: [...skills, { ...skills[0]!, name: "status" }],
      commands: [
        { name: "status", description: "Native status", argumentHint: "" },
        { name: "team-notes", description: "Native notes", argumentHint: "" },
        { name: "team-notes", description: "Duplicate", argumentHint: "" },
      ],
      harnessLabel: "Claude Code",
    });
    expect(result.map(({ name, kind }) => [name, kind])).toEqual([
      ["status", "status"],
      ["team-notes", "skill"],
    ]);
  });
  it("searches titles, descriptions, and names with exact names first", () => {
    expect(matchSlashEntries(entries, "Meeting")[0]?.name).toBe("team-notes");
    expect(matchSlashEntries(entries, "minutes")[0]?.name).toBe("team-notes");
    expect(matchSlashEntries(entries, "compact")[0]?.name).toBe("compact");
    expect(matchSlashEntries(entries, "zzzzzz")).toEqual([]);
  });
  it("ranks command names ahead of titles and literal description matches", () => {
    const candidates = [
      { ...entries[0]!, name: "other", title: "Compact", description: "" },
      {
        ...entries[0]!,
        name: "summary",
        title: "Summary",
        description: "Compact this chat",
      },
      { ...entries[0]!, name: "compact-more", title: "More", description: "" },
      { ...entries[0]!, name: "compact", title: "Compress", description: "" },
    ];
    expect(
      matchSlashEntries(candidates, " COMPACT ").map(({ name }) => name),
    ).toEqual(["compact", "compact-more", "other", "summary"]);
  });
  it("does not fuzzy-match across descriptions or field boundaries", () => {
    const candidates = [
      {
        ...entries[0]!,
        name: "notes",
        title: "Notes",
        description: "Create organized meeting plans and capture tasks",
      },
      { ...entries[0]!, name: "co", title: "mp", description: "act" },
    ];
    expect(matchSlashEntries(candidates, "compact")).toEqual([]);
    expect(matchSlashEntries(entries, "cmpct")[0]?.name).toBe("compact");
  });
  it.each(["", " ", "\n"])(
    "invokes skills with trailing whitespace %j",
    (tail) => {
      expect(resolveSlashMessage(`/team-notes${tail}`, entries)).toBe(
        'Use the "team-notes" skill.',
      );
    },
  );
  it("preserves arguments, multiline instructions, and attachment positions", () => {
    expect(
      resolveSlashMessage("/team-notes take minutes\nfor ￼ please", entries),
    ).toBe('Use the "team-notes" skill: take minutes\nfor ￼ please');
    expect(resolveSlashMessage("/team-notes￼", entries)).toBe(
      'Use the "team-notes" skill: ￼',
    );
  });
  it("uses the native Codex path without sending a fictitious CLI command", () => {
    expect(resolveSlashMessage("/native-notes today", entries)).toBe(
      'Use the "native-notes" skill at "/tmp/my skills/SKILL.md". today',
    );
  });
  it.each([
    "/compact focus on tests",
    "/plugin:check 42",
    "/unknown text",
    "/tmp/file.md",
    "Tell me about /team-notes",
    "/status",
  ])("preserves native commands and ordinary text: %s", (message) => {
    expect(resolveSlashMessage(message, entries)).toBe(message);
  });
});
