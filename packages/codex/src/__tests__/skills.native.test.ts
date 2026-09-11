import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { CodexAppServer } from "../app-server.js";

it("discovers native skills from the requested checkout and refreshes file edits without a thread", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-skills-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "checkout");
  const dir = path.join(cwd, ".agents/skills/release-notes");
  await mkdir(home, { recursive: true });
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  const server = new CodexAppServer({
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
    const first = await server.listSkills({ workingDirectory: cwd });
    expect(first).toContainEqual({
      name: "release-notes",
      description: "Original release notes",
      path: await realpath(file),
    });
    await writeFile(
      file,
      "---\nname: release-notes\ndescription: Updated release notes\n---\nWrite release notes.\n",
    );
    const second = await server.listSkills({ workingDirectory: cwd });
    expect(second).toContainEqual({
      name: "release-notes",
      description: "Updated release notes",
      path: await realpath(file),
    });
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
