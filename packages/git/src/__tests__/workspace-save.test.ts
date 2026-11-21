import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nativeGit } from "../native-git.js";
import {
  assertSavedPath,
  parseSavedChanges,
  ReceivedPack,
  type SavedChange,
  savedDraftChanges,
  WorkspaceSaveError,
  writeSavedChanges,
} from "../workspace-save.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const ZERO = "0".repeat(40);
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** One record of `git diff-tree --raw -z`, as the sandbox's manifest holds it. */
function record(input: {
  before?: string;
  after: string;
  oid?: string;
  path: string | Uint8Array;
}): Uint8Array {
  const before = input.before ?? "000000";
  const status =
    input.after === "000000" ? "D" : before === "000000" ? "A" : "M";
  const meta = `:${before} ${input.after} ${before === "000000" ? ZERO : A} ${
    input.after === "000000" ? ZERO : (input.oid ?? B)
  } ${status}`;
  const name =
    typeof input.path === "string"
      ? new TextEncoder().encode(input.path)
      : input.path;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(meta),
      Buffer.from([0]),
      name,
      Buffer.from([0]),
    ]),
  );
}

const manifest = (...records: Uint8Array[]) =>
  new Uint8Array(Buffer.concat(records));

describe("a save's manifest (ADR 0341)", () => {
  it("reads files, executables, links and deletions with their exact paths", () => {
    expect(
      parseSavedChanges(
        manifest(
          record({ after: "100644", path: "notes é.txt" }),
          record({ after: "100755", path: 'bin/run "it".sh' }),
          record({ after: "120000", path: "link" }),
          record({ before: "100644", after: "000000", path: "line\nbreak" }),
          record({ before: "100644", after: "100644", path: "a\tb" }),
        ),
      ),
    ).toEqual([
      { path: "notes é.txt", kind: "file", mode: "100644", oid: B },
      { path: 'bin/run "it".sh', kind: "file", mode: "100755", oid: B },
      { path: "link", kind: "link", oid: B },
      { path: "line\nbreak", kind: "deleted" },
      { path: "a\tb", kind: "file", mode: "100644", oid: B },
    ]);
    expect(parseSavedChanges(new Uint8Array())).toEqual([]);
  });

  it("leaves nested repositories out, and deletes the file one replaced", () => {
    expect(
      parseSavedChanges(
        manifest(
          record({ after: "160000", path: "vendor/lib" }),
          record({ before: "160000", after: "000000", path: "gone" }),
          record({ before: "100644", after: "160000", path: "was-a-file" }),
        ),
      ),
    ).toEqual([{ path: "was-a-file", kind: "deleted" }]);
  });

  it("refuses paths that leave the checkout or enter a Git directory", () => {
    for (const hostile of [
      "../outside",
      "a/../../outside",
      "/etc/passwd",
      "a//b",
      "./a",
      ".git/hooks/pre-commit",
      "sub/.git/config",
      ".GIT/config",
      "sub/.Git/hooks/x",
      ".git",
      ".g‌it/config",
      ".git./config",
      ".git /config",
      "git~1/config",
      ".git::$INDEX_ALLOCATION/config",
      "",
    ]) {
      expect(() => assertSavedPath(hostile), hostile).toThrow(
        WorkspaceSaveError,
      );
      expect(
        () =>
          parseSavedChanges(
            manifest(record({ after: "100644", path: hostile })),
          ),
        hostile,
      ).toThrow(WorkspaceSaveError);
      // A deletion is checked like a write.
      expect(
        () =>
          parseSavedChanges(
            manifest(
              record({ before: "100644", after: "000000", path: hostile }),
            ),
          ),
        hostile,
      ).toThrow(WorkspaceSaveError);
    }
    for (const fine of [".gitignore", ".github/workflows/ci.yml", "a.git/b"])
      expect(() => assertSavedPath(fine), fine).not.toThrow();
  });

  it("refuses records Git would not write", () => {
    const refused = (bytes: Uint8Array) =>
      expect(() => parseSavedChanges(bytes)).toThrow(WorkspaceSaveError);
    // Cut short: a record without its path, or without its last NUL.
    refused(record({ after: "100644", path: "a" }).subarray(0, 96));
    refused(record({ after: "100644", path: "a" }).subarray(0, -1));
    // A mode that is no file, a status that is no change, an id that is none.
    refused(manifest(record({ after: "040000", path: "a" })));
    refused(manifest(record({ after: "100664", path: "a" })));
    refused(new TextEncoder().encode(`:000000 100644 ${ZERO} ${B} R100\0a\0`));
    refused(new TextEncoder().encode(`:000000 100644 ${ZERO} zz A\0a\0`));
    refused(new TextEncoder().encode(`:000000 000000 ${ZERO} ${B} A\0a\0`));
    // The same path twice, and a file that is also a folder.
    refused(
      manifest(
        record({ after: "100644", path: "a" }),
        record({ after: "100755", path: "a" }),
      ),
    );
    refused(
      manifest(
        record({ after: "120000", path: "a" }),
        record({ after: "100644", path: "a/b" }),
      ),
    );
    // A name that is not UTF-8 cannot be written under its own name.
    refused(
      manifest(
        record({ after: "100644", path: Uint8Array.from([0xff, 0x61]) }),
      ),
    );
  });
});

describe("writing a save into a checkout (ADR 0341)", () => {
  let dir: string;
  let source: string;
  let checkout: string;
  let outside: string;
  let packs: ReceivedPack[];

  /** Store `content` as a blob in the sandbox's stand-in repository. */
  const blob = (content: Uint8Array | string) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        "git",
        ["-C", source, "hash-object", "-w", "--no-filters", "--stdin"],
        (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
      );
      child.stdin?.end(content);
    });

  /** The pack a sandbox would send for these objects. */
  const packBytes = (oids: readonly string[]) =>
    new Promise<Uint8Array>((resolve, reject) => {
      const child = execFile(
        "git",
        ["-C", source, "pack-objects", "--stdout", "-q"],
        { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
        (error, stdout) =>
          error ? reject(error) : resolve(new Uint8Array(stdout)),
      );
      // A pack always holds something: the manifest, in a real save.
      void (
        oids.length > 0
          ? Promise.resolve(oids)
          : blob("manifest").then((oid) => [oid])
      ).then((packed) => child.stdin?.end(`${packed.join("\n")}\n`), reject);
    });

  const receive = async (bytes: Uint8Array, chunk = 1000) => {
    const pack = await ReceivedPack.receive({
      objectFormat: "sha1",
      chunks: (async function* () {
        for (let offset = 0; offset < bytes.length; offset += chunk)
          yield bytes.subarray(offset, offset + chunk);
      })(),
    });
    packs.push(pack);
    return pack;
  };

  const save = async (changes: readonly SavedChange[]) => {
    const pack = await receive(
      await packBytes(
        changes.flatMap((change) =>
          change.kind === "deleted" ? [] : [change.oid],
        ),
      ),
    );
    await writeSavedChanges({ repoPath: checkout, changes, pack });
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-save-"));
    source = path.join(dir, "source");
    checkout = path.join(dir, "checkout");
    outside = path.join(dir, "outside");
    packs = [];
    for (const folder of [source, checkout, outside]) await fs.mkdir(folder);
    await nativeGit(source, ["init", "-q", "-b", "main"]);
    await fs.writeFile(path.join(outside, "secret"), "untouched\n");
  });

  afterEach(async () => {
    for (const pack of packs) await pack.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes bytes, executable bits, links and deletions exactly", async () => {
    const binary = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 7) % 256);
    await fs.writeFile(path.join(checkout, "old.txt"), "old\n");
    await fs.mkdir(path.join(checkout, "kept"));
    await fs.writeFile(path.join(checkout, "kept", "other"), "stays\n");
    await save([
      {
        path: "data/all.bin",
        kind: "file",
        mode: "100644",
        oid: await blob(binary),
      },
      {
        path: "run.sh",
        kind: "file",
        mode: "100755",
        oid: await blob("#!/bin/sh\n"),
      },
      { path: "link", kind: "link", oid: await blob("data/all.bin") },
      { path: "empty", kind: "file", mode: "100644", oid: await blob("") },
      { path: "old.txt", kind: "deleted" },
      { path: "never/was/here", kind: "deleted" },
    ]);
    const saved = await fs.readFile(path.join(checkout, "data", "all.bin"));
    expect(sha256(saved)).toBe(sha256(binary));
    expect((await fs.lstat(path.join(checkout, "run.sh"))).mode & 0o100).toBe(
      0o100,
    );
    expect(
      (await fs.lstat(path.join(checkout, "data", "all.bin"))).mode & 0o111,
    ).toBe(0);
    expect(await fs.readlink(path.join(checkout, "link"))).toBe("data/all.bin");
    expect((await fs.stat(path.join(checkout, "empty"))).size).toBe(0);
    await expect(fs.stat(path.join(checkout, "old.txt"))).rejects.toThrow();
    expect(
      await fs.readFile(path.join(checkout, "kept", "other"), "utf8"),
    ).toBe("stays\n");
    // An executable that stops being one loses its bit.
    await save([
      {
        path: "run.sh",
        kind: "file",
        mode: "100644",
        oid: await blob("plain\n"),
      },
    ]);
    expect((await fs.lstat(path.join(checkout, "run.sh"))).mode & 0o111).toBe(
      0,
    );
  });

  it("never writes or deletes through a link saved earlier", async () => {
    // An earlier save left links that point outside the checkout.
    await save([
      { path: "evil", kind: "link", oid: await blob(outside) },
      {
        path: "passwd",
        kind: "link",
        oid: await blob(path.join(outside, "secret")),
      },
    ]);
    expect(await fs.readlink(path.join(checkout, "evil"))).toBe(outside);

    // A file under the link is refused, and nothing lands outside.
    await expect(
      save([
        {
          path: "evil/planted",
          kind: "file",
          mode: "100644",
          oid: await blob("x"),
        },
      ]),
    ).rejects.toThrow(/through a link/);
    await expect(
      save([{ path: "evil/deep/link", kind: "link", oid: await blob("x") }]),
    ).rejects.toThrow(WorkspaceSaveError);
    expect(await fs.readdir(outside)).toEqual(["secret"]);

    // A deletion under the link finds nothing of the checkout's there.
    await save([{ path: "evil/secret", kind: "deleted" }]);
    expect(await fs.readFile(path.join(outside, "secret"), "utf8")).toBe(
      "untouched\n",
    );

    // A file saved where a link stands replaces the link, not its target.
    await save([
      {
        path: "passwd",
        kind: "file",
        mode: "100644",
        oid: await blob("mine\n"),
      },
    ]);
    expect((await fs.lstat(path.join(checkout, "passwd"))).isFile()).toBe(true);
    expect(await fs.readFile(path.join(checkout, "passwd"), "utf8")).toBe(
      "mine\n",
    );
    expect(await fs.readFile(path.join(outside, "secret"), "utf8")).toBe(
      "untouched\n",
    );

    // Deleting a link removes the link alone; a folder may then take its name.
    await save([
      { path: "evil", kind: "deleted" },
      {
        path: "evil/inside",
        kind: "file",
        mode: "100644",
        oid: await blob("in\n"),
      },
    ]);
    expect(
      await fs.readFile(path.join(checkout, "evil", "inside"), "utf8"),
    ).toBe("in\n");
    expect(await fs.readdir(outside)).toEqual(["secret"]);
  });

  it("keeps only links that stay inside a folder whose files follow links", async () => {
    const contained = async (file: string, target: string) => {
      const oid = await blob(target);
      const pack = await receive(await packBytes([oid]));
      await writeSavedChanges({
        repoPath: checkout,
        changes: [{ path: file, kind: "link", oid }],
        pack,
        containLinks: true,
      });
    };
    await contained("readme-link", "README.md");
    await contained("deep/er/up", "../../README.md");
    await contained("deep/er/side", "./../sibling/file");
    expect(await fs.readlink(path.join(checkout, "deep", "er", "up"))).toBe(
      "../../README.md",
    );
    for (const [file, target] of [
      ["out", outside],
      ["out", "../outside/secret"],
      ["deep/out", "../../outside"],
      // A climb after a name could pass through a link the save wrote.
      ["climb", "readme-link/../../outside"],
      ["deep/climb", "../deep/er/../../../outside"],
      ["git", ".git/config"],
      ["deep/git", "../.GIT/hooks"],
    ] as const) {
      await expect(contained(file, target), target).rejects.toThrow(
        /leads outside the project folder/,
      );
      await expect(fs.lstat(path.join(checkout, file))).rejects.toThrow();
    }
  });

  it("refuses unsafe paths however the changes were made", async () => {
    const oid = await blob("x");
    for (const hostile of ["../outside/planted", "/tmp/planted", ".git/config"])
      await expect(
        save([{ path: hostile, kind: "file", mode: "100644", oid }]),
      ).rejects.toThrow(WorkspaceSaveError);
    await expect(
      save([{ path: "../outside/secret", kind: "deleted" }]),
    ).rejects.toThrow(WorkspaceSaveError);
    expect(await fs.readdir(outside)).toEqual(["secret"]);
    expect(await fs.readdir(checkout)).toEqual([]);
    // A personal file is never written from a workspace; deleting one is skipped.
    await expect(
      save([
        { path: ".work/personal/notes.md", kind: "file", mode: "100644", oid },
      ]),
    ).rejects.toThrow(/personal file/);
    await fs.mkdir(path.join(checkout, ".work", "personal"), {
      recursive: true,
    });
    await fs.writeFile(path.join(checkout, ".work", "personal", "mine"), "m");
    await save([{ path: ".work/personal/mine", kind: "deleted" }]);
    expect(
      await fs.readFile(
        path.join(checkout, ".work", "personal", "mine"),
        "utf8",
      ),
    ).toBe("m");
  });

  it("lets a file take an emptied folder's place, never one that holds files", async () => {
    await fs.mkdir(path.join(checkout, "was-folder", "deep"), {
      recursive: true,
    });
    await fs.writeFile(path.join(checkout, "was-folder", "deep", "f"), "f");
    await fs.mkdir(path.join(checkout, "busy"));
    await fs.writeFile(path.join(checkout, "busy", "untracked"), "keep");
    await fs.writeFile(path.join(checkout, "was-file"), "f");
    await save([
      { path: "was-folder/deep/f", kind: "deleted" },
      {
        path: "was-folder",
        kind: "file",
        mode: "100644",
        oid: await blob("now a file"),
      },
      { path: "was-file", kind: "deleted" },
      {
        path: "was-file/child",
        kind: "file",
        mode: "100644",
        oid: await blob("c"),
      },
    ]);
    expect(await fs.readFile(path.join(checkout, "was-folder"), "utf8")).toBe(
      "now a file",
    );
    expect(
      await fs.readFile(path.join(checkout, "was-file", "child"), "utf8"),
    ).toBe("c");
    await expect(
      save([
        { path: "busy", kind: "file", mode: "100644", oid: await blob("x") },
      ]),
    ).rejects.toThrow(/still holds files/);
    expect(
      await fs.readFile(path.join(checkout, "busy", "untracked"), "utf8"),
    ).toBe("keep");
  });

  it("refuses a pack that arrived damaged, cut short, or without what it names", async () => {
    const oid = await blob("content that must arrive whole\n".repeat(200));
    const bytes = await packBytes([oid]);
    const flipped = Uint8Array.from(bytes);
    const middle = Math.floor(flipped.length / 2);
    flipped[middle] = (flipped[middle] ?? 0) ^ 0xff;
    await expect(receive(flipped)).rejects.toThrow(WorkspaceSaveError);
    await expect(receive(bytes.subarray(0, bytes.length - 7))).rejects.toThrow(
      WorkspaceSaveError,
    );
    // Text decoding, the bug this replaces, never yields a pack either.
    await expect(
      receive(new TextEncoder().encode(Buffer.from(bytes).toString("utf8"))),
    ).rejects.toThrow(WorkspaceSaveError);
    await expect(receive(new Uint8Array())).rejects.toThrow(WorkspaceSaveError);

    const pack = await receive(bytes);
    await expect(
      pack.assertBlobs({ oids: [oid], maxBytes: 1024 * 1024 }),
    ).resolves.toBeUndefined();
    // Named but not sent, larger than allowed, and not an id at all.
    await expect(
      pack.assertBlobs({ oids: [oid, A], maxBytes: 1024 * 1024 }),
    ).rejects.toThrow(/lacks a file/);
    await expect(
      pack.assertBlobs({ oids: [oid], maxBytes: 100 }),
    ).rejects.toThrow(/more than/);
    await expect(
      pack.assertBlobs({ oids: ["HEAD"], maxBytes: 100 }),
    ).rejects.toThrow(WorkspaceSaveError);
    await expect(
      writeSavedChanges({
        repoPath: checkout,
        changes: [{ path: "a", kind: "file", mode: "100644", oid: A }],
        pack,
      }),
    ).rejects.toThrow(WorkspaceSaveError);
    // A link's target is bounded and never empty.
    const long = await receive(await packBytes([await blob("x".repeat(5000))]));
    await expect(
      writeSavedChanges({
        repoPath: checkout,
        changes: [
          { path: "long", kind: "link", oid: await blob("x".repeat(5000)) },
        ],
        pack: long,
      }),
    ).rejects.toThrow(WorkspaceSaveError);
    await expect(fs.lstat(path.join(checkout, "long"))).rejects.toThrow();
  });

  it("refuses a tree or commit where a file's content is named", async () => {
    await fs.writeFile(path.join(source, "f"), "f");
    await nativeGit(source, ["add", "-A"]);
    const tree = (await nativeGit(source, ["write-tree"])).trim();
    const pack = await receive(await packBytes([tree]));
    await expect(
      pack.assertBlobs({ oids: [tree], maxBytes: 1024 }),
    ).rejects.toThrow(WorkspaceSaveError);
    await expect(pack.read({ oid: tree, maxBytes: 1024 })).rejects.toThrow(
      WorkspaceSaveError,
    );
  });

  it("turns a save into draft changes with the same bytes, modes and links", async () => {
    const binary = Uint8Array.from({ length: 300 }, (_, i) => i % 256);
    const changes: SavedChange[] = [
      { path: "b.bin", kind: "file", mode: "100644", oid: await blob(binary) },
      {
        path: "run.sh",
        kind: "file",
        mode: "100755",
        oid: await blob("#!/bin/sh\n"),
      },
      { path: "link", kind: "link", oid: await blob("../elsewhere") },
      { path: "old", kind: "deleted" },
    ];
    const pack = await receive(
      await packBytes(
        changes.flatMap((change) =>
          change.kind === "deleted" ? [] : [change.oid],
        ),
      ),
    );
    expect(await savedDraftChanges({ changes, pack })).toEqual([
      { path: "b.bin", content: binary, mode: "100644" },
      {
        path: "run.sh",
        content: new TextEncoder().encode("#!/bin/sh\n"),
        mode: "100755",
      },
      {
        path: "link",
        content: new TextEncoder().encode("../elsewhere"),
        mode: "120000",
      },
      { path: "old", delete: true },
    ]);
    await expect(
      savedDraftChanges({
        changes: [{ path: "../x", kind: "file", mode: "100644", oid: A }],
        pack,
      }),
    ).rejects.toThrow(WorkspaceSaveError);
  });
});
