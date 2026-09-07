import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readEditorFile, writeEditorFile } from "./editor-files.js";

it("opens external artifacts without overwriting a concurrent agent edit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "editor-files-"));
  const filePath = path.join(dir, "notes.md");
  try {
    await writeFile(filePath, "original");
    expect(await readEditorFile({ filePath })).toEqual({ content: "original" });
    await writeEditorFile({
      filePath,
      content: "saved",
      expectedContent: "original",
    });
    await writeFile(filePath, "agent edit");
    await expect(
      writeEditorFile({ filePath, content: "draft", expectedContent: "saved" }),
    ).rejects.toThrow("changed on disk");
    expect(await readFile(filePath, "utf8")).toBe("agent edit");
    await writeFile(filePath, Buffer.from([0, 1, 2]));
    await expect(readEditorFile({ filePath })).rejects.toThrow("binary");
    await expect(readEditorFile({ filePath: dir })).rejects.toThrow(
      "not a file",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
