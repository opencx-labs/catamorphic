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

it("stops the whole process group when a command times out or is cancelled", async () => {
  const { runLocalCommand } = await import("./local-agent-workspace.js");
  const marker = `${os.tmpdir()}/workspace-orphan-${process.pid}-${Date.now()}`;
  const timedOut = await runLocalCommand(
    `echo started; (sleep 3 && touch ${marker}) & sleep 30`,
    { timeout: 1 },
  );
  expect(timedOut.exitCode).toBe(124);
  expect(timedOut.result).toContain("started");
  expect(timedOut.result).toContain("timed out");

  const controller = new AbortController();
  const cancelled = runLocalCommand("sleep 30", { signal: controller.signal });
  controller.abort();
  expect((await cancelled).exitCode).toBe(130);

  // The backgrounded child died with its group instead of outliving the command.
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  await expect(fs.stat(marker)).rejects.toThrow();
}, 15_000);

it("keeps stdout and stderr in order with the real exit code", async () => {
  const { runLocalCommand } = await import("./local-agent-workspace.js");
  const result = await runLocalCommand("echo one; echo two >&2; exit 4");
  expect(result).toEqual({ exitCode: 4, result: "one\ntwo\n" });
});
