import { describe, expect, it } from "vitest";
import { HOST_SKILLS } from "../seeds.js";
import { parseProjectEnvironmentPolicy } from "../services/project-environments-service.js";
import {
  SANDBOX_SECRETS_PATH,
  sandboxSecretsNote,
} from "../services/sandbox-secrets.js";
import { parseSkillFrontmatter } from "../services/skills-service.js";

const SKILL = HOST_SKILLS["personal-environment/SKILL.md"] ?? "";
const json = [...SKILL.matchAll(/```json\n([\s\S]*?)```/g)].map(
  (match) => match[1] ?? "",
);

/*
 * The skill an agent reads about its workspace's secrets and private files
 * (ADRs 0184, 0199, 0205) states what Work actually does.
 */
describe("the personal-environment skill", () => {
  it("has parseable frontmatter and no dashes a reader would trip on", () => {
    const frontmatter = parseSkillFrontmatter(SKILL);
    expect(frontmatter.name).toBe("personal-environment");
    expect(frontmatter.description).toContain("environment variables");
    expect(SKILL).not.toMatch(/[–—]/);
  });

  it("shows a project.json that declares and lists secrets as Work parses it", () => {
    const manifest = json.find((block) => block.includes('"environments"'));
    const policy = parseProjectEnvironmentPolicy(JSON.parse(manifest ?? "{}"));
    expect(policy.invalid).toBeUndefined();
    expect(policy.secrets).toHaveProperty("CLICKHOUSE_API_KEY");
    expect(policy.environments.dev?.secrets).toEqual([
      "CLICKHOUSE_API_KEY",
      "SENTRY_DSN",
    ]);
  });

  it("names the file and the places Work's notes send people", () => {
    expect(SKILL).toContain(`. ../${SANDBOX_SECRETS_PATH}`);
    const note =
      sandboxSecretsNote({
        environment: "dev",
        owner: "ada",
        missing: [{ name: "CLICKHOUSE_API_KEY", reason: "unset" }],
      }) ?? "";
    expect(note).toContain("under Secrets in Work");
    expect(SKILL).toContain("under **Secrets** in Work");
    // Sign-ins stay on their machine (ADR 0199): nothing sends them.
    expect(SKILL).not.toContain('"logins"');
    expect(SKILL).toContain("never sent anywhere");
  });
});
