import { describe, expect, it } from "vitest";
import { assertSandboxVolumes } from "../sandbox-volumes.js";
import {
  CACHE_VOLUME_KEY_PATTERN,
  cacheVolumeKey,
  parseCacheVolumeKey,
  SANDBOX_VOLUME_KEY_PATTERN,
  volumeKey,
} from "../types.js";

describe("cache volume keys (ADR 0334)", () => {
  it("names each generation of one cache under one family", () => {
    const first = cacheVolumeKey({
      projectId: "p",
      environment: "review",
      name: "pnpm",
      generation: 7,
    });
    const next = cacheVolumeKey({
      projectId: "p",
      environment: "review",
      name: "pnpm",
      generation: 12,
    });
    expect(first).toMatch(CACHE_VOLUME_KEY_PATTERN);
    expect(first).toMatch(SANDBOX_VOLUME_KEY_PATTERN);
    expect(parseCacheVolumeKey(first)).toEqual({
      family: parseCacheVolumeKey(next)?.family,
      generation: 7,
    });
    expect(parseCacheVolumeKey(next)?.generation).toBe(12);
    // Another project's or Environment's cache is another family.
    expect(
      parseCacheVolumeKey(
        cacheVolumeKey({
          projectId: "q",
          environment: "review",
          name: "pnpm",
          generation: 7,
        }),
      )?.family,
    ).not.toBe(parseCacheVolumeKey(first)?.family);
    // An owner's volume is never a cache generation.
    expect(
      parseCacheVolumeKey(volumeKey({ projectId: "p", owner: "m", name: "x" })),
    ).toBeUndefined();
    expect(() =>
      cacheVolumeKey({
        projectId: "p",
        environment: "e",
        name: "pnpm",
        generation: 0,
      }),
    ).toThrow("not a cache generation");
  });

  it("accepts a cache generation as a volume, never exclusive or temporary", () => {
    const key = cacheVolumeKey({
      projectId: "p",
      environment: "review",
      name: "pnpm",
      generation: 1,
    });
    expect(() =>
      assertSandboxVolumes([{ key, path: "~/.pnpm-store", readOnly: true }]),
    ).not.toThrow();
    expect(() =>
      assertSandboxVolumes([{ key, path: "/x", temporary: true }]),
    ).toThrow("cannot be exclusive or temporary");
    expect(() =>
      assertSandboxVolumes([{ key, path: "/x", exclusive: true }]),
    ).toThrow("cannot be exclusive or temporary");
  });
});
