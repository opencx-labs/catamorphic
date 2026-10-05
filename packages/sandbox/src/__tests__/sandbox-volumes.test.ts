import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSandboxVolumes,
  imageUserHome,
  VolumeUsageLog,
  volumeMountPath,
} from "../sandbox-volumes.js";
import { volumeKey } from "../types.js";

const key = volumeKey({ projectId: "p", owner: "m", name: "cache" });

describe("sandbox volumes", () => {
  it("accepts keyed absolute and ~ paths, once each", () => {
    expect(() =>
      assertSandboxVolumes([
        { key, path: "~/.cache/pnpm" },
        { key, path: "/var/lib/docker", exclusive: true },
        { key, path: "~" },
      ]),
    ).not.toThrow();
    expect(() => assertSandboxVolumes([{ key: "cache", path: "/x" }])).toThrow(
      "not a volume key",
    );
    expect(() => assertSandboxVolumes([{ key, path: "relative" }])).toThrow(
      "must be absolute",
    );
    expect(() => assertSandboxVolumes([{ key, path: "/a/../b" }])).toThrow(
      "may not contain",
    );
    expect(() =>
      assertSandboxVolumes([
        { key, path: "/a" },
        { key, path: "/a" },
      ]),
    ).toThrow("share the path");
  });

  it("finds the image user's home and places ~ paths in it", () => {
    expect(imageUserHome({})).toBe("/root");
    expect(imageUserHome({ user: "root" })).toBe("/root");
    expect(imageUserHome({ user: "0:0" })).toBe("/root");
    expect(imageUserHome({ user: "node" })).toBe("/home/node");
    expect(imageUserHome({ user: "1000", env: ["HOME=/home/app/"] })).toBe(
      "/home/app",
    );
    expect(imageUserHome({ user: "1000" })).toBe("");
    expect(volumeMountPath({ path: "~/.cache", home: "/root" })).toBe(
      "/root/.cache",
    );
    expect(volumeMountPath({ path: "~", home: "/home/node" })).toBe(
      "/home/node",
    );
    expect(volumeMountPath({ path: "/data", home: "" })).toBe("/data");
    expect(() => volumeMountPath({ path: "~/.cache", home: "" })).toThrow(
      "no known home",
    );
  });
});

describe("VolumeUsageLog", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      fs.rmSync(directory, { recursive: true, force: true });
  });
  const log = () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "work-volumes-"));
    directories.push(directory);
    return new VolumeUsageLog(path.join(directory, "state", "volumes.json"));
  };

  it("records the latest use and forgets removed volumes", () => {
    const usage = log();
    usage.touch(["a", "b"], 1_000);
    usage.touch(["a"], 5_000);
    usage.touch(["a"], 2_000);
    expect(usage.entries()).toEqual({ a: 5_000, b: 1_000 });
    usage.forget(["b"]);
    expect(usage.lastUsed("b")).toBeUndefined();
    expect(usage.lastUsed("a")).toBe(5_000);
  });

  it("counts an unrecorded volume from its creation", () => {
    const usage = log();
    usage.touch(["used"], 10_000);
    expect(usage.unused({ key: "used", unusedForMs: 5_000, now: 14_000 })).toBe(
      false,
    );
    expect(usage.unused({ key: "used", unusedForMs: 5_000, now: 15_000 })).toBe(
      true,
    );
    expect(
      usage.unused({
        key: "lost",
        unusedForMs: 5_000,
        since: 12_000,
        now: 15_000,
      }),
    ).toBe(false);
    expect(usage.unused({ key: "lost", unusedForMs: 5_000, now: 15_000 })).toBe(
      false,
    );
  });
});
