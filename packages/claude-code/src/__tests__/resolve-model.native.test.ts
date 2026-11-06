import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveClaudeCodeModel } from "../list-models.js";

it("resolves the model a session in this folder would run with the pinned CLI, local settings first", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "claude-model-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "checkout");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(path.join(cwd, ".claude"), { recursive: true }),
  ]);
  await writeFile(
    path.join(home, "settings.json"),
    JSON.stringify({ model: "sonnet" }),
  );
  const env = {
    CLAUDE_CONFIG_DIR: home,
    ANTHROPIC_API_KEY: "fixture-only",
    ANTHROPIC_AUTH_TOKEN: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    ANTHROPIC_MODEL: "",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
  };
  try {
    const user = await resolveClaudeCodeModel({ workingDirectory: cwd, env });
    expect(user?.id).toMatch(/sonnet/);
    await writeFile(
      path.join(cwd, ".claude/settings.local.json"),
      JSON.stringify({ model: "haiku" }),
    );
    const local = await resolveClaudeCodeModel({ workingDirectory: cwd, env });
    expect(local?.id).toMatch(/haiku/);
    expect(local?.name).toBeTruthy();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
