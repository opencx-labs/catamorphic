import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nativeGit } from "../native-git.js";
import {
  advertiseCheckout,
  CHECKOUT_BRANCH,
  openCheckoutSource,
  serveCheckout,
} from "../workspace-checkout.js";
import {
  buildSeedPack,
  seedPackInstallScript,
  seedPackParts,
} from "../workspace-mirror.js";

const execute = promisify(execFile);
const author = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.test",
] as const;

/*
 * A workspace's base as a Git remote (ADR 0353): a throwaway repository
 * serves one commit of the copy that holds it over smart HTTP, and a
 * plain `git fetch` brings it, whole or as much as the fetch asks for.
 */
describe("checkout sources (ADR 0353)", () => {
  let dir: string;
  let copy: string;
  let server: Server | undefined;
  let before: string;
  let base: string;

  const commit = async (files: Record<string, string>, message: string) => {
    for (const [name, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(copy, name)), { recursive: true });
      await fs.writeFile(path.join(copy, name), content);
    }
    await nativeGit(copy, ["add", "-A"]);
    await nativeGit(copy, [...author, "commit", "-q", "-m", message]);
    return (await nativeGit(copy, ["rev-parse", "HEAD"])).trim();
  };

  /** Serve `commit` of the copy over smart HTTP, as a gateway route would. */
  const serve = async (commitId: string) => {
    server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? "/", "http://work.test");
        const source = await openCheckoutSource({
          repoPath: copy,
          commit: commitId,
        });
        try {
          const advertise =
            request.method === "GET" && url.pathname.endsWith("/info/refs");
          response.writeHead(200, {
            "content-type": advertise
              ? "application/x-git-upload-pack-advertisement"
              : "application/x-git-upload-pack-result",
          });
          const body = advertise
            ? advertiseCheckout({ directory: source.directory })
            : serveCheckout({ directory: source.directory, request });
          for await (const chunk of body) response.write(chunk);
        } finally {
          response.end();
          await source.dispose();
        }
      })();
    });
    await new Promise<void>((resolve) =>
      server?.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test server address");
    return `http://127.0.0.1:${address.port}/checkout`;
  };

  /** An empty repository with the served one as its `work` remote. */
  const sandbox = async (name: string, url: string) => {
    const directory = path.join(dir, name);
    await fs.mkdir(directory);
    await nativeGit(directory, ["init", "-q", "-b", "main"]);
    await nativeGit(directory, ["remote", "add", "work", url]);
    return directory;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-checkout-test-"));
    copy = path.join(dir, "copy");
    await fs.mkdir(copy);
    await nativeGit(copy, ["init", "-q", "-b", "main"]);
    before = await commit({ "app/main.ts": "one\n" }, "Before");
    base = await commit(
      { "app/main.ts": "two\n", "data/big.bin": "x".repeat(200_000) },
      "Base",
    );
  });

  afterEach(async () => {
    await new Promise<void>((resolve) =>
      server ? server.close(() => resolve()) : resolve(),
    );
    server = undefined;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("advertises one branch at the commit, shallow there, borrowing the copy's objects", async () => {
    const source = await openCheckoutSource({ repoPath: copy, commit: base });
    try {
      expect(
        (
          await nativeGit(source.directory, [
            "for-each-ref",
            "--format=%(refname) %(objectname)",
          ])
        ).trim(),
      ).toBe(`refs/heads/${CHECKOUT_BRANCH} ${base}`);
      expect(
        (
          await fs.readFile(path.join(source.directory, "shallow"), "utf8")
        ).trim(),
      ).toBe(base);
      // Nothing of its own: the commit is read from the copy.
      expect(
        await fs.readdir(path.join(source.directory, "objects", "pack")),
      ).toEqual([]);
    } finally {
      await source.dispose();
    }
    await expect(fs.access(source.directory)).rejects.toThrow();
    // The copy is left as it was: no ref, no shallow file.
    await expect(
      fs.access(path.join(copy, ".git", "shallow")),
    ).rejects.toThrow();
    await expect(
      openCheckoutSource({ repoPath: copy, commit: "0".repeat(40) }),
    ).rejects.toThrow();
  });

  it("serves the commit to a plain shallow fetch, and nothing before it", async () => {
    const url = await serve(base);
    const directory = await sandbox("plain", url);
    await nativeGit(directory, [
      "fetch",
      "-q",
      "--no-tags",
      "--depth=1",
      "work",
      base,
    ]);
    await nativeGit(directory, ["checkout", "-q", "--detach", "FETCH_HEAD"]);
    expect((await nativeGit(directory, ["rev-parse", "HEAD"])).trim()).toBe(
      base,
    );
    expect(await fs.readFile(path.join(directory, "app/main.ts"), "utf8")).toBe(
      "two\n",
    );
    expect((await nativeGit(directory, ["log", "--format=%s"])).trim()).toBe(
      "Base",
    );
    // An earlier commit is in the copy, and named by the base itself, but
    // not reachable from what is advertised: refused.
    const other = await sandbox("earlier", url);
    await expect(
      nativeGit(other, [
        "fetch",
        "-q",
        "--no-tags",
        "--depth=1",
        "work",
        before,
      ]),
    ).rejects.toThrow(/not our ref/);
  });

  it("lets the fetch leave blobs out and check out a sparse cone", async () => {
    const url = await serve(base);
    const directory = await sandbox("sparse", url);
    await nativeGit(directory, ["sparse-checkout", "set", "--cone", "app"]);
    await nativeGit(directory, [
      "fetch",
      "-q",
      "--no-tags",
      "--depth=1",
      "--filter=blob:none",
      "work",
      base,
    ]);
    await nativeGit(directory, ["checkout", "-q", "--detach", "FETCH_HEAD"]);
    expect((await nativeGit(directory, ["rev-parse", "HEAD"])).trim()).toBe(
      base,
    );
    expect(await fs.readdir(directory)).toEqual([".git", "app"]);
    // The file outside the cone never travelled.
    const missing = (
      await nativeGit(directory, [
        "rev-list",
        "--objects",
        "--missing=print",
        "HEAD",
      ])
    )
      .split("\n")
      .filter((line) => line.startsWith("?"));
    expect(missing).toHaveLength(1);
  });

  it("sends a receiver that holds an earlier base only what the new one adds", async () => {
    const first = await serve(base);
    const directory = await sandbox("moved", first);
    await nativeGit(directory, [
      "fetch",
      "-q",
      "--no-tags",
      "--depth=1",
      "work",
      base,
    ]);
    // As a seeded checkout marks the base it stands on.
    await nativeGit(directory, ["update-ref", "refs/work/base", base]);
    await new Promise<void>((resolve) =>
      server ? server.close(() => resolve()) : resolve(),
    );
    const next = await commit({ "app/main.ts": "three\n" }, "Next");
    const second = await serve(next);
    await nativeGit(directory, ["remote", "set-url", "work", second]);
    const { stderr } = await execute(
      "git",
      [
        "-C",
        directory,
        "fetch",
        "--no-tags",
        "--depth=1",
        "--progress",
        "work",
        next,
      ],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );
    // The commit, two trees and one small file: never the large one again.
    const total = /Total (\d+)/.exec(stderr)?.[1];
    expect(Number(total)).toBeLessThanOrEqual(4);
    expect((await nativeGit(directory, ["cat-file", "-t", next])).trim()).toBe(
      "commit",
    );
  });

  it("packs only what a session added when the receiver holds the base", async () => {
    const head = await commit({ "app/main.ts": "session\n" }, "Session work");
    const whole = await buildSeedPack({ repoPath: copy, head, base });
    const added = await buildSeedPack({
      repoPath: copy,
      head,
      base,
      holdsBase: true,
    });
    // The session's commit, its two trees and its one file.
    expect(added.objects).toBe(4);
    expect(added.objects).toBeLessThan(whole.objects);
    expect(added.pack.byteLength).toBeLessThan(whole.pack.byteLength);
    // Nothing added: nothing to send, with or without a saved tree.
    const tree = async (commit: string) =>
      (await nativeGit(copy, ["rev-parse", `${commit}^{tree}`])).trim();
    for (const saved of [undefined, await tree(base)])
      expect(
        (
          await buildSeedPack({
            repoPath: copy,
            head: base,
            base,
            ...(saved ? { tree: saved } : {}),
            holdsBase: true,
          })
        ).objects,
      ).toBe(0);
    // A head still on its base, with saved work it has not committed:
    // the two trees and the one file that differ, and no commit.
    expect(
      (
        await buildSeedPack({
          repoPath: copy,
          head: base,
          base,
          tree: await tree(head),
          holdsBase: true,
        })
      ).objects,
    ).toBe(3);

    // A checkout that fetched the base takes the rest from the pack.
    const url = await serve(base);
    const directory = await sandbox("delta", url);
    await nativeGit(directory, [
      "fetch",
      "-q",
      "--no-tags",
      "--depth=1",
      "work",
      base,
    ]);
    for (const part of seedPackParts({ pack: added.pack, name: "seed.b64" }))
      await fs.writeFile(path.join(dir, part.name), part.content);
    await execute(
      "bash",
      [
        "-c",
        `${seedPackInstallScript({ packFile: "../seed.b64", shallow: added.shallow })} && git checkout -q -f -B work/abc ${head}`,
      ],
      { cwd: directory },
    );
    expect(await fs.readFile(path.join(directory, "app/main.ts"), "utf8")).toBe(
      "session\n",
    );
    expect((await nativeGit(directory, ["log", "--format=%s"])).trim()).toBe(
      "Session work\nBase",
    );
  });

  it("uploads a pack of any size as parts that decode joined", async () => {
    // Past two parts: each holds 3 MiB of the pack as 4 MiB of text.
    const pack = new Uint8Array(7 * 1024 * 1024).map((_, index) => index % 251);
    const parts = seedPackParts({ pack, name: "seed.b64" });
    expect(parts.map((part) => part.name)).toEqual([
      "seed.b64.000000",
      "seed.b64.000001",
      "seed.b64.000002",
    ]);
    expect(parts.map((part) => part.content.length)).toEqual([
      4 * 1024 * 1024,
      4 * 1024 * 1024,
      Math.ceil((1024 * 1024) / 3) * 4,
    ]);
    // As the sandbox reads them: in name order, through one decoder.
    const folder = await fs.mkdtemp(path.join(dir, "parts-"));
    for (const part of parts)
      await fs.writeFile(path.join(folder, part.name), part.content);
    await fs.writeFile(path.join(folder, "pack"), pack);
    await execute(
      "bash",
      ["-c", `cat seed.b64.${"[0-9]".repeat(6)} | base64 -d | cmp - pack`],
      { cwd: folder },
    );
    expect(seedPackParts({ pack: new Uint8Array(), name: "seed.b64" })).toEqual(
      [],
    );
  });
});
