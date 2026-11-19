import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { localDocumentPath } from "../services/local-document-files.js";
import { localDocumentRelativePath } from "../services/project-workspace.js";

let root: string;

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "local-documents-")),
  );
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function create(relative: string): Promise<void> {
  const target = path.join(root, localDocumentRelativePath(relative));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "{}");
}

/** Whether this filesystem finds an existing file by another spelling. */
async function aliases(spelled: string): Promise<boolean> {
  return fs
    .stat(path.join(root, localDocumentRelativePath(spelled)))
    .then(() => true)
    .catch(() => false);
}

it("a store path names the file on disk only as it is spelled there (ADR 0335)", async () => {
  await create("store/github-polling/acme-web.json");
  await expect(
    localDocumentPath(root, "store/github-polling/acme-web.json"),
  ).resolves.toBe(
    path.join(
      root,
      localDocumentRelativePath("store/github-polling/acme-web.json"),
    ),
  );
  // Granted store/Github-Polling/, a path must not reach another grant's
  // store/github-polling/ through a filesystem that ignores case.
  const otherCase = "store/Github-Polling/acme-web.json";
  if (await aliases(otherCase))
    await expect(localDocumentPath(root, otherCase)).rejects.toThrow(
      "Document paths must match the names on disk exactly, in case and Unicode form",
    );
  // Where case matters it is simply another file, which does not exist.
  else await expect(localDocumentPath(root, otherCase)).resolves.toBeTruthy();
  // A folder that does not exist yet is fine to create.
  await expect(
    localDocumentPath(root, "store/github-polling/new/cursor.json"),
  ).resolves.toBeTruthy();
});

it("nor in another Unicode form of the same name", async () => {
  const composed = "store/caf\u00e9/notes.md".normalize("NFC");
  const decomposed = composed.normalize("NFD");
  expect(decomposed).not.toBe(composed);
  await create(composed);
  if (await aliases(decomposed))
    await expect(localDocumentPath(root, decomposed)).rejects.toThrow(
      "Document paths must match the names on disk exactly",
    );
  else await expect(localDocumentPath(root, decomposed)).resolves.toBeTruthy();
  await expect(localDocumentPath(root, composed)).resolves.toBeTruthy();
});
