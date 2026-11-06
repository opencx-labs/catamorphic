import { describe, expect, it } from "vitest";
import {
  entryInvocation,
  parseSkillInvocation,
  type SkillEntry,
  skillEntries,
} from "./skill-entries";
import { skillsForAgent } from "./skills";

const skills = [
  {
    name: "team-notes",
    title: "Meeting notes",
    description: "Write clear minutes",
    argumentHint: "[meeting]",
    source: "project" as const,
    path: ".agents/skills/team-notes/SKILL.md",
  },
];
const entries = skillEntries({
  skills,
  commands: [
    {
      name: "compact",
      description: "Summarize",
      argumentHint: "[instructions]",
    },
    {
      name: "native-notes",
      description: "Native skill",
      argumentHint: "",
      skillPath: "/tmp/my skills/SKILL.md",
    },
  ],
  harnessLabel: "Native",
  status: true,
});
const entry = (name: string): SkillEntry => {
  const found = entries.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no entry ${name}`);
  return found;
};

describe("skill entries", () => {
  it("offers only the agent's picked skills", () => {
    expect(skillsForAgent(skills, { mode: "picked", names: [] })).toEqual([]);
    expect(
      skillsForAgent(skills, { mode: "picked", names: ["team-notes"] }),
    ).toEqual(skills);
    expect(skillsForAgent(skills, { mode: "all" })).toEqual(skills);
  });

  it("reserves status for a chat and deduplicates skills and native commands", () => {
    const result = skillEntries({
      skills: [...skills, { ...skills[0]!, name: "status" }],
      commands: [
        { name: "status", description: "Native status", argumentHint: "" },
        { name: "team-notes", description: "Native notes", argumentHint: "" },
        { name: "team-notes", description: "Duplicate", argumentHint: "" },
        { name: "two words", description: "Not a name", argumentHint: "" },
      ],
      harnessLabel: "Claude Code",
      status: true,
    });
    expect(result.map(({ name, kind }) => [name, kind])).toEqual([
      ["status", "status"],
      ["team-notes", "skill"],
    ]);
    expect(
      skillEntries({
        skills: [],
        commands: [],
        harnessLabel: "Claude Code",
        status: false,
      }),
    ).toEqual([]);
  });

  it("labels each tier and keeps a skill's argument hint", () => {
    expect(entry("team-notes")).toMatchObject({
      title: "Meeting notes",
      source: "Project skill",
      argumentHint: "[meeting]",
    });
    expect(entry("compact")).toMatchObject({
      title: "/compact",
      source: "Native",
      kind: "command",
    });
    expect(entry("native-notes")).toMatchObject({
      title: "native-notes",
      kind: "skill",
    });
  });
});

describe("skill invocations", () => {
  it.each(["", " ", "\n"])(
    "invokes a shared skill with empty instructions %j",
    (instructions) => {
      expect(entryInvocation(entry("team-notes"), instructions)).toBe(
        'Use the "team-notes" skill.',
      );
    },
  );

  it("keeps multiline instructions", () => {
    expect(
      entryInvocation(entry("team-notes"), " take minutes\nfor the review "),
    ).toBe('Use the "team-notes" skill: take minutes\nfor the review');
  });

  it("names a Codex skill's file instead of a fictitious CLI command", () => {
    expect(entryInvocation(entry("native-notes"), "today")).toBe(
      'Use the "native-notes" skill at "/tmp/my skills/SKILL.md". today',
    );
  });

  it("sends a native command as the harness reads it", () => {
    expect(entryInvocation(entry("compact"))).toBe("/compact");
    expect(entryInvocation(entry("compact"), "focus on tests")).toBe(
      "/compact focus on tests",
    );
  });

  it.each([
    ['Use the "team-notes" skill.', "team-notes", ""],
    ['Use the "team-notes" skill: take minutes', "team-notes", "take minutes"],
    ['Use the "team-notes" skill.\n￼￼', "team-notes", "￼￼"],
    [
      'Use the "native-notes" skill at "/tmp/my \\"skills\\"/SKILL.md". today',
      "native-notes",
      "today",
    ],
  ])("reads %j back as its skill", (text, name, rest) => {
    expect(parseSkillInvocation(text)).toEqual({ name, rest });
  });

  it.each([
    "Use the team-notes skill.",
    'Please use the "team-notes" skill.',
    "/compact",
    'Use the "two\nlines" skill.',
  ])("leaves ordinary text alone: %j", (text) => {
    expect(parseSkillInvocation(text)).toBeNull();
  });
});
