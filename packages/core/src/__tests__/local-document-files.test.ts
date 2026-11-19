import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DocumentNotFoundError,
  LocalDocumentSpellingError,
} from "../services/document-errors.js";
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
      LocalDocumentSpellingError,
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
      LocalDocumentSpellingError,
    );
  else await expect(localDocumentPath(root, decomposed)).resolves.toBeTruthy();
  await expect(localDocumentPath(root, composed)).resolves.toBeTruthy();
});

it("costs the same in a folder of thousands: no folder is read whole", async () => {
  const fill = async (folderPath: string, count: number) => {
    const folder = path.join(root, localDocumentRelativePath(folderPath));
    await fs.mkdir(folder, { recursive: true });
    const names = Array.from(
      { length: count },
      (_, index) => `n-${index}.json`,
    );
    for (const name of names) await fs.writeFile(path.join(folder, name), "{}");
    return names;
  };
  const one = await fill("store/one/", 1);
  const many = await fill("store/many/", 4000);
  const readdir = vi.spyOn(fs, "readdir");
  /** Milliseconds per check of 400 files in the folder. */
  const perCall = async (folder: string, names: string[]) => {
    const started = performance.now();
    for (let index = 0; index < 400; index++)
      await localDocumentPath(root, `${folder}${names[index % names.length]}`);
    return (performance.now() - started) / 400;
  };
  await perCall("store/one/", one);
  const small = await perCall("store/one/", one);
  const large = await perCall("store/many/", many);
  expect(readdir).not.toHaveBeenCalled();
  readdir.mockRestore();
  // Reading the folder for each check made one in 4000 files 7 times slower.
  expect(large).toBeLessThan(small * 3 + 0.2);
}, 120_000);

it("a folder removed while it is checked is simply not found", async () => {
  await create("store/gone/notes.md");
  const folder = path.join(root, localDocumentRelativePath("store/gone"));
  const original = fs.lstat;
  // The folder disappears between looking at the path and reading its
  // spelling, as when another process deletes it.
  const lstat = async (...args: Parameters<typeof fs.lstat>) => {
    const stat = await original(...args);
    if (String(args[0]) === path.join(folder, "notes.md"))
      await fs.rm(folder, { recursive: true, force: true });
    return stat;
  };
  Object.assign(fs, { lstat });
  try {
    await expect(
      localDocumentPath(root, "store/gone/notes.md"),
    ).rejects.toThrow(DocumentNotFoundError);
  } finally {
    Object.assign(fs, { lstat: original });
  }
});
