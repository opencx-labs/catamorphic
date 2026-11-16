import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  markTestRunDirectory,
  removeExpiredTestRuns,
  TEST_RUN_RETENTION_MS,
} from "./test-retention.js";

describe("removeExpiredTestRuns", () => {
  let parent: string;
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const ago = (ms: number) => new Date(now - ms);

  beforeEach(async () => {
    parent = await mkdtemp(path.join(tmpdir(), "retention-"));
  });
  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  const directory = async (
    name: string,
    modified: Date,
    contents: { directories?: string[]; files?: string[] } = {},
  ) => {
    const root = path.join(parent, name);
    await mkdir(root);
    for (const child of contents.directories ?? [])
      await mkdir(path.join(root, child), { recursive: true });
    for (const file of contents.files ?? [])
      await writeFile(path.join(root, file), "");
    await utimes(root, modified, modified);
    return root;
  };
  /** A run that has ended: no process has this id. */
  const ENDED = 999_999_999;
  const run = async (name: string, modified: Date, pid = ENDED) => {
    const root = await directory(name, modified);
    await markTestRunDirectory(root, pid);
    await utimes(root, modified, modified);
  };

  it("keeps the newest few failed runs and removes the rest", async () => {
    // Six marked failed runs, a day apart.
    for (let index = 1; index <= 6; index++)
      await run(`ct-Run00${index}`, ago(index * 24 * hour));
    // Unmarked, from before the marker: recognized by their layout.
    await directory("ct-Old007", ago(7 * 24 * hour - hour), {
      directories: ["logs", "tmp", "bun-cache", "turbo-cache", "xdg-cache"],
    });
    await directory("dOld008", ago(30 * 24 * hour), {
      directories: ["source", "manifests"],
      files: ["Dockerfile"],
    });
    // Younger than six hours: maybe still running, and not counted.
    await run("ct-Now001", ago(hour));
    await run("dNow0002", ago(2 * hour));
    // Not a run's: similar names, other contents.
    await directory("ct-Mno345", ago(30 * 24 * hour), {
      directories: ["logs"],
    });
    await directory("data12", ago(30 * 24 * hour), { files: ["notes.txt"] });
    await directory("ct-toolongname", ago(30 * 24 * hour), {
      files: [".catamorphic-test-run"],
    });

    const removed = await removeExpiredTestRuns({ parent, now });

    expect(removed.map((root) => path.basename(root)).sort()).toEqual([
      "ct-Old007",
      "ct-Run006",
      "dOld008",
    ]);
    expect((await readdir(parent)).sort()).toEqual([
      "ct-Mno345",
      "ct-Now001",
      "ct-Run001",
      "ct-Run002",
      "ct-Run003",
      "ct-Run004",
      "ct-Run005",
      "ct-toolongname",
      "dNow0002",
      "data12",
    ]);
  });

  it("removes a run past the retention even among the newest", async () => {
    await run("ct-Week01", ago(TEST_RUN_RETENTION_MS + hour));
    await run("ct-Day002", ago(24 * hour));
    const removed = await removeExpiredTestRuns({ parent, now });
    expect(removed.map((root) => path.basename(root))).toEqual(["ct-Week01"]);
  });

  it("never removes the root of a run whose process is alive", async () => {
    // Suspended with its machine overnight: old, but still running.
    await run("ct-Live01", ago(TEST_RUN_RETENTION_MS + hour), process.pid);
    expect(await removeExpiredTestRuns({ parent, now, keep: 0 })).toEqual([]);
    expect(await readdir(parent)).toEqual(["ct-Live01"]);
  });

  it("does nothing when the parent folder is missing", async () => {
    expect(
      await removeExpiredTestRuns({
        parent: path.join(parent, "missing"),
        now,
      }),
    ).toEqual([]);
  });
});
