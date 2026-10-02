import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { listCodexSkills } from "../skills.js";
import { pinnedCodexCommand } from "../testing/pinned.js";

it("discovers native skills from the requested checkout and refreshes file edits without a thread", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-skills-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "checkout");
  const dir = path.join(cwd, ".agents/skills/release-notes");
  await mkdir(home, { recursive: true });
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  const list = () =>
    listCodexSkills({
      executable: pinnedCodexCommand(),
      workingDirectory: cwd,
      env: {
        CODEX_HOME: home,
        OPENAI_API_KEY: "",
        CODEX_API_KEY: "",
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
      },
    });
  try {
    await writeFile(
      file,
      "---\nname: release-notes\ndescription: Original release notes\n---\nWrite release notes.\n",
    );
    expect(await list()).toContainEqual({
      name: "release-notes",
      description: "Original release notes",
      path: await realpath(file),
    });
    await writeFile(
      file,
      "---\nname: release-notes\ndescription: Updated release notes\n---\nWrite release notes.\n",
    );
    expect(await list()).toContainEqual({
      name: "release-notes",
      description: "Updated release notes",
      path: await realpath(file),
    });
  } finally {
    // The native process's final writes can race removal.
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});
