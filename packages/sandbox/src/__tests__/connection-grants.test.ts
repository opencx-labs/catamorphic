import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONNECTION_GRANT_READER,
  MODEL_GRANT_READER,
  readConnectionGrant,
} from "../connection-grants.js";

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("append-only connection grants", () => {
  it("keeps the greatest exact numeric revision after delayed old publication in JS and native helpers", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "work grants #"));
    directories.push(directory);
    await writeFile(path.join(directory, "9007199254740992"), "old");
    await writeFile(path.join(directory, "9007199254740993"), "current");
    await writeFile(path.join(directory, "staging"), "incomplete");
    await mkdir(path.join(directory, "9223372036854775807"));
    const native = async () =>
      (
        await execute("sh", [
          "-c",
          CONNECTION_GRANT_READER,
          "work-read-grant",
          directory,
        ])
      ).stdout;
    const model = async () =>
      (
        await execute("sh", ["-c", MODEL_GRANT_READER], {
          env: { ...process.env, WORK_MODEL_GRANT_DIRECTORY: directory },
        })
      ).stdout;
    expect(await readConnectionGrant({ directory })).toBe("current");
    expect(await native()).toBe("current");
    expect(await model()).toBe("current");
    // An earlier request finishes publication after the new one is visible.
    await writeFile(path.join(directory, "9"), "late-old");
    expect(await readConnectionGrant({ directory })).toBe("current");
    expect(await native()).toBe("current");
    expect(await model()).toBe("current");
    await writeFile(path.join(directory, "9223372036854775806"), "next");
    expect(await readConnectionGrant({ directory })).toBe("next");
    expect(await native()).toBe("next");
    expect(await model()).toBe("next");
  });

  it("refuses an empty grant source in JS and the native helper", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "work-empty-grants-"),
    );
    directories.push(directory);
    await expect(readConnectionGrant({ directory })).rejects.toThrow(
      "No published connection grant",
    );
    await expect(
      execute("sh", [
        "-c",
        CONNECTION_GRANT_READER,
        "work-read-grant",
        directory,
      ]),
    ).rejects.toThrow();
  });
});
