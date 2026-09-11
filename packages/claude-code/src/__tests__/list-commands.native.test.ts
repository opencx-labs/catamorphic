import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { listClaudeSlashCommands } from "../list-commands.js";

it("discovers project commands and installed plugin skills with the pinned CLI without executing hooks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "claude-commands-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "checkout");
  const plugin = path.join(root, "plugin");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(path.join(cwd, ".claude/commands"), { recursive: true }),
    mkdir(path.join(plugin, ".claude-plugin"), { recursive: true }),
    mkdir(path.join(plugin, "skills/release-notes"), { recursive: true }),
  ]);
  const hookMarker = path.join(root, "hook-ran");
  await writeFile(
    path.join(cwd, ".claude/settings.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: `touch '${hookMarker}'` }] },
        ],
      },
    }),
  );
  await writeFile(
    path.join(cwd, ".claude/commands/check-release.md"),
    "---\ndescription: Check the release\nargument-hint: <version>\n---\nCheck $ARGUMENTS.\n",
  );
  await writeFile(
    path.join(plugin, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "release-tools", version: "1.0.0" }),
  );
  await writeFile(
    path.join(plugin, "skills/release-notes/SKILL.md"),
    "---\nname: release-notes\ndescription: Write release notes\n---\nWrite the notes.\n",
  );
  try {
    const commands = await listClaudeSlashCommands({
      workingDirectory: cwd,
      plugins: [{ type: "local", path: plugin }],
      env: {
        CLAUDE_CONFIG_DIR: home,
        ANTHROPIC_API_KEY: "fixture-only",
        ANTHROPIC_AUTH_TOKEN: "",
        CLAUDE_CODE_OAUTH_TOKEN: "",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
      },
    });
    expect(commands.some((command) => command.name === "compact")).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.name === "check-release" &&
          command.argumentHint === "<version>",
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) => command.name === "release-tools:release-notes",
      ),
    ).toBe(true);
    await expect(access(hookMarker)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
