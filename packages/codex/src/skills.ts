import { CodexAppServer, isObject } from "./app-server.js";

export interface CodexSkill {
  name: string;
  description: string;
  path: string;
}

/** Fresh native skills, using the selected account and checkout. No model turn. */
export async function listCodexSkills({
  executable,
  env,
  workingDirectory,
  timeoutMs = 15_000,
}: {
  executable: string;
  env?: Record<string, string>;
  workingDirectory: string;
  timeoutMs?: number;
}): Promise<CodexSkill[]> {
  const server = new CodexAppServer({
    spawn: {
      command: executable,
      args: ["app-server"],
      env: env ?? {},
      cwd: workingDirectory,
    },
  });
  const timeout = setTimeout(() => void server.close(), timeoutMs);
  try {
    await server.initialize();
    const result = await server.request(
      "skills/list",
      { cwds: [workingDirectory], forceReload: true },
      { timeoutMs },
    );
    return parseSkillCatalog(result);
  } finally {
    clearTimeout(timeout);
    void server.close();
  }
}

function parseSkillCatalog(result: unknown): CodexSkill[] {
  if (!isObject(result) || !Array.isArray(result.data))
    throw new Error("Codex returned an invalid skill catalog.");
  const skills: CodexSkill[] = [];
  for (const group of result.data) {
    if (!isObject(group) || !Array.isArray(group.skills))
      throw new Error("Codex returned an invalid skill catalog.");
    if (Array.isArray(group.errors) && group.errors.length > 0)
      throw new Error(
        "Codex could not load some skills. Check their SKILL.md files.",
      );
    for (const skill of group.skills) {
      if (!isObject(skill) || skill.enabled === false) continue;
      if (typeof skill.name !== "string" || typeof skill.path !== "string")
        throw new Error("Codex returned an invalid skill.");
      skills.push({
        name: skill.name,
        description:
          typeof skill.description === "string" ? skill.description : "",
        path: skill.path,
      });
    }
  }
  return skills;
}
