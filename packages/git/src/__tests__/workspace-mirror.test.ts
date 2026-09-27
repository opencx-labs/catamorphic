import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsBackend } from "../fs-backend.js";
import { InMemoryObjectStore } from "../in-memory-object-store.js";
import { nativeGit } from "../native-git.js";
import { ObjectRemoteBackend } from "../object-remote-backend.js";
import { ProjectManager } from "../project-manager.js";
import {
  buildSeedPack,
  fetchIntoMirror,
  mirrorChangedFiles,
  parseWorkspaceRef,
  seedPackInstallScript,
} from "../workspace-mirror.js";

const execute = promisify(execFile);
const TENANT = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const PROJECT = "f1e2d3c4-b5a6-7890-dcba-fedcba987654";
const author = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.test",
] as const;

describe("workspace refs (ADR 0178)", () => {
  let dir: string;
  let upstream: string;
  let work: string;

  const commit = async (files: Record<string, string>, message: string) => {
    for (const [name, content] of Object.entries(files))
      await fs.writeFile(path.join(work, name), content);
    await nativeGit(work, ["add", "-A"]);
    await nativeGit(work, [...author, "commit", "-q", "-m", message]);
    return (await nativeGit(work, ["rev-parse", "HEAD"])).trim();
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-mirror-"));
    upstream = path.join(dir, "upstream.git");
    work = path.join(dir, "work");
    await fs.mkdir(upstream);
    await nativeGit(upstream, ["init", "--bare", "-q", "-b", "main"]);
    await fs.mkdir(work);
    await nativeGit(work, ["init", "-q", "-b", "main"]);
    await commit({ "readme.md": "hello\n", "app.ts": "one\n" }, "Initial");
    await nativeGit(work, ["push", "-q", upstream, "main"]);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("accepts branches, tags, full refs, and commits, never options or refspecs", () => {
    for (const ref of ["main", "v1.2", "refs/pull/42/head", "a".repeat(40)])
      expect(parseWorkspaceRef(ref)).toBe(ref);
    for (const ref of ["-x", "a:b", "+main", "a..b", "a b", "x\u0001"])
      expect(() => parseWorkspaceRef(ref)).toThrow(/not a branch/);
  });

  it("fetches a pull request head into the mirror and seeds a session copy at it", async () => {
    await nativeGit(work, ["checkout", "-q", "-b", "feature"]);
    const head = await commit({ "app.ts": "two\n" }, "Change app");
    await nativeGit(work, ["push", "-q", upstream, "HEAD:refs/pull/42/head"]);

    const remote = new ObjectRemoteBackend({
      store: new InMemoryObjectStore(),
    });
    const manager = new ProjectManager(
      new FsBackend(path.join(dir, "a")),
      remote,
    );
    const created = await manager.create(TENANT, PROJECT);
    await created.dispose();
    const mirrorPath = manager.mirrorPath({
      tenantId: TENANT,
      projectId: PROJECT,
    });
    if (!mirrorPath) throw new Error("expected a mirror");
    const pin = "refs/sessions/s1";
    const fetched = await fetchIntoMirror({
      mirrorPath,
      url: upstream,
      ref: "refs/pull/42/head",
      pin,
    });
    expect(fetched.commit).toBe(head);

    const args = { tenantId: TENANT, projectId: PROJECT, sessionId: "s1" };
    await manager.setSessionBase({ ...args, pin, commit: head });
    const copy = await manager.openSession(args);
    expect(await copy.resolveRef("HEAD")).toBe(head);
    expect(await copy.readFile("app.ts")).toBe("two\n");
    await copy.dispose();

    // Another machine's cache rehydrates the same base from the session branch.
    const other = new ProjectManager(
      new FsBackend(path.join(dir, "b")),
      remote,
    );
    const moved = await other.openSession(args);
    expect(await moved.resolveRef("HEAD")).toBe(head);
    await moved.dispose();

    // A force-pushed head moves the base, and the change is summarized.
    await nativeGit(work, ["checkout", "-q", "main"]);
    await nativeGit(work, ["checkout", "-q", "-b", "rewritten"]);
    const next = await commit(
      { "app.ts": "three\n", "new.ts": "x\n" },
      "Rewrite",
    );
    await nativeGit(work, [
      "push",
      "-q",
      "--force",
      upstream,
      "HEAD:refs/pull/42/head",
    ]);
    const refetched = await fetchIntoMirror({
      mirrorPath,
      url: upstream,
      ref: "refs/pull/42/head",
      pin,
    });
    expect(refetched.commit).toBe(next);
    expect(
      await mirrorChangedFiles({ mirrorPath, from: head, to: next }),
    ).toEqual({ files: ["app.ts", "new.ts"], total: 2 });
    await manager.setSessionBase({ ...args, pin, commit: next });
    const reset = await manager.openSession(args);
    expect(await reset.readFile("app.ts")).toBe("three\n");
    await reset.dispose();
  });

  it("rebases a session's checkpoints onto a new base, and undoes a conflicting rebase", async () => {
    await nativeGit(work, ["checkout", "-q", "-b", "feature"]);
    const first = await commit({ "app.ts": "two\n" }, "First push");
    await nativeGit(work, ["push", "-q", upstream, "HEAD:refs/pull/7/head"]);
    const remote = new ObjectRemoteBackend({
      store: new InMemoryObjectStore(),
    });
    const manager = new ProjectManager(
      new FsBackend(path.join(dir, "a")),
      remote,
    );
    (await manager.create(TENANT, PROJECT)).dispose();
    const mirrorPath = manager.mirrorPath({
      tenantId: TENANT,
      projectId: PROJECT,
    });
    if (!mirrorPath) throw new Error("expected a mirror");
    const pin = "refs/work/base/s2";
    const args = { tenantId: TENANT, projectId: PROJECT, sessionId: "s2" };
    await fetchIntoMirror({
      mirrorPath,
      url: upstream,
      ref: "refs/pull/7/head",
      pin,
    });
    await manager.setSessionBase({ ...args, pin, commit: first });
    const copy = await manager.openSession(args);
    await copy.writeFile("notes.md", "review notes\n");
    await copy.dispose();
    await manager.checkpointSession({
      ...args,
      message: "Turn",
      author: { name: "Agent", email: "agent@example.test" },
    });

    const second = await commit({ "readme.md": "hello again\n" }, "Second");
    await nativeGit(work, ["push", "-q", upstream, "HEAD:refs/pull/7/head"]);
    await fetchIntoMirror({
      mirrorPath,
      url: upstream,
      ref: "refs/pull/7/head",
      pin,
    });
    const rebased = await manager.moveSessionBase({
      ...args,
      pin,
      from: first,
      to: second,
      update: "rebase",
    });
    expect(rebased.status).toBe("moved");
    const moved = await manager.openSession(args);
    expect(await moved.readFile("notes.md")).toBe("review notes\n");
    expect(await moved.readFile("readme.md")).toBe("hello again\n");
    await moved.writeFile("readme.md", "session edit\n");
    await moved.dispose();
    await manager.checkpointSession({
      ...args,
      message: "Edit readme",
      author: { name: "Agent", email: "agent@example.test" },
    });

    const third = await commit({ "readme.md": "upstream edit\n" }, "Third");
    await nativeGit(work, ["push", "-q", upstream, "HEAD:refs/pull/7/head"]);
    await fetchIntoMirror({
      mirrorPath,
      url: upstream,
      ref: "refs/pull/7/head",
      pin,
    });
    const before = await manager.openSession(args);
    const headBefore = await before.resolveRef("HEAD");
    await before.dispose();
    const conflict = await manager.moveSessionBase({
      ...args,
      pin,
      from: second,
      to: third,
      update: "rebase",
    });
    expect(conflict).toEqual({
      status: "conflict",
      head: headBefore,
      files: ["readme.md"],
    });
    const kept = await manager.openSession(args);
    expect(await kept.readFile("readme.md")).toBe("session edit\n");
    expect((await kept.status()).dirty).toBe(false);
    await kept.dispose();
  });

  it("builds a shallow seed pack a fresh repository can check out", async () => {
    const base = await commit({ "app.ts": "two\n" }, "Base");
    const head = await commit({ "app.ts": "three\n" }, "Session work");
    const { pack, shallow } = await buildSeedPack({
      repoPath: work,
      head,
      base,
    });
    expect(shallow).toHaveLength(1);

    const sandbox = path.join(dir, "sandbox");
    await fs.mkdir(sandbox);
    await nativeGit(sandbox, ["init", "-q", "-b", "main"]);
    await fs.writeFile(
      path.join(dir, "seed.b64"),
      Buffer.from(pack).toString("base64"),
    );
    await execute(
      "bash",
      [
        "-c",
        `${seedPackInstallScript({ packFile: "../seed.b64", shallow })} && git update-ref refs/heads/main ${head} && git reset -q --hard main`,
      ],
      { cwd: sandbox },
    );
    expect((await nativeGit(sandbox, ["rev-parse", "HEAD"])).trim()).toBe(head);
    expect(await fs.readFile(path.join(sandbox, "app.ts"), "utf8")).toBe(
      "three\n",
    );
    const log = await nativeGit(sandbox, ["log", "--format=%s"]);
    expect(log.trim().split("\n")).toEqual(["Session work", "Base"]);
    await expect(fs.access(path.join(dir, "seed.b64"))).rejects.toThrow();
  });
});
