import { execFileSync } from "node:child_process";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFilePreview } from "./file-preview";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "preview-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function file(name: string, contents: string | Buffer) {
  const filePath = path.join(root, name);
  await writeFile(filePath, contents);
  return filePath;
}
it("reads bounded UTF-8 prefixes without breaking a multibyte character", async () => {
  const filePath = await file("notes.md", `${"a".repeat(16383)}€more`);
  const result = await readFilePreview({ filePath });
  expect(result.content).toEqual({
    kind: "text",
    format: "markdown",
    text: "a".repeat(16383),
    truncated: true,
  });
  expect(result.location).toBe(filePath);
});
it("keeps HTML as inert text and rejects binary content", async () => {
  expect(
    (
      await readFilePreview({
        filePath: await file("page.html", "<script>alert(1)</script>"),
      })
    ).content,
  ).toMatchObject({ kind: "text", text: "<script>alert(1)</script>" });
  expect(
    (
      await readFilePreview({
        filePath: await file("binary.zip", Buffer.from([80, 75, 0, 255])),
      })
    ).content.kind,
  ).toBe("unavailable");
});
it.each([
  ["image.png", "image", "image/png"],
  ["audio.wav", "audio", "audio/wav"],
  ["clip.webm", "video", "video/webm"],
])("provides bounded media: %s", async (name, kind, mediaType) => {
  const result = await readFilePreview({
    filePath: await file(name, "sample"),
  });
  expect(result.content).toMatchObject({
    kind,
    src: `data:${mediaType};base64,c2FtcGxl`,
  });
});
it("does not read oversized media or thumbnail oversized documents", async () => {
  const filePath = await file("huge.png", "");
  await truncate(filePath, 17 * 1024 * 1024);
  expect((await readFilePreview({ filePath })).content).toMatchObject({
    kind: "unavailable",
    message: expect.stringContaining("too large"),
  });
  const pdf = await file("huge.pdf", "");
  await truncate(pdf, 129 * 1024 * 1024);
  const thumbnail = vi.fn();
  await readFilePreview({ filePath: pdf, thumbnail });
  expect(thumbnail).not.toHaveBeenCalled();
});
it("uses native document thumbnails with a graceful failure fallback", async () => {
  const filePath = await file("report.pdf", "%PDF-1.4");
  expect(
    (
      await readFilePreview({
        filePath,
        thumbnail: async () => "data:image/png;base64,test",
      })
    ).content.kind,
  ).toBe("image");
  expect(
    (
      await readFilePreview({
        filePath,
        thumbnail: async () => {
          throw new Error("Unsupported");
        },
      })
    ).content.kind,
  ).toBe("unavailable");
});
it("rejects missing and relative files and describes folders", async () => {
  await expect(readFilePreview({ filePath: "relative.png" })).rejects.toThrow(
    "absolute",
  );
  await expect(
    readFilePreview({ filePath: path.join(root, "gone.png") }),
  ).rejects.toThrow();
  expect((await readFilePreview({ filePath: root })).content).toEqual({
    kind: "unavailable",
    message: "Folder",
  });
});
it.skipIf(process.platform === "win32")(
  "never blocks opening a named pipe",
  async () => {
    const filePath = path.join(root, "pipe");
    execFileSync("mkfifo", [filePath]);
    expect((await readFilePreview({ filePath })).content.kind).toBe(
      "unavailable",
    );
  },
);
