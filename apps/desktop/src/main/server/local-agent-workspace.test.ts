import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { localAgentWorkspace } from "./local-agent-workspace.js";

it("runs in the selected checkout and updates files directly without replacing other work", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-agent-"));
  try {
    await fs.writeFile(path.join(root, "outside-edit.txt"), "from editor");
    const result = await localAgentWorkspace.executeCommand("native", "pwd", {
      cwd: root,
    });
    expect(result.exitCode).toBe(0);
    expect(result.result.trim()).toBe(await fs.realpath(root));
    await localAgentWorkspace.uploadFiles(
      "native",
      { "notes.md": "from agent" },
      root,
    );
    expect(
      await localAgentWorkspace.downloadFile(
        "native",
        path.join(root, "notes.md"),
      ),
    ).toBe("from agent");
    expect(await fs.readFile(path.join(root, "outside-edit.txt"), "utf8")).toBe(
      "from editor",
    );
    expect((await fs.readdir(root)).sort()).toEqual([
      "notes.md",
      "outside-edit.txt",
    ]);
    await expect(
      localAgentWorkspace.uploadFiles("native", { "../escape": "no" }, root),
    ).rejects.toThrow("escapes");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
