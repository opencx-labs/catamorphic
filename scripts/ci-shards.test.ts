import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverTestFiles, shardMatrix } from "./ci-shards.js";

describe("automatic CI shards", () => {
  it("adds a runner when another file exceeds the target and shrinks with the suite", () => {
    const matrix = (files: number) =>
      shardMatrix({ files, filesPerShard: 5, maxShards: 32 });
    expect(matrix(38)).toHaveLength(8);
    expect(matrix(40)).toHaveLength(8);
    expect(matrix(41)).toHaveLength(9);
    expect(matrix(5)).toEqual([{ shard: 1, total: 1 }]);
    expect(matrix(0)).toEqual([{ shard: 1, total: 1 }]);
  });

  it("emits every shard exactly once with the same denominator, even at the runner cap", () => {
    const matrix = shardMatrix({
      files: 100_000,
      filesPerShard: 5,
      maxShards: 32,
    });
    expect(matrix).toEqual(
      Array.from({ length: 32 }, (_, index) => ({
        shard: index + 1,
        total: 32,
      })),
    );
  });

  it("honors Vitest include/exclude rules without importing tests", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "ct-shard-discovery-"));
    try {
      const config = path.join(cwd, "vitest.config.mjs");
      writeFileSync(
        config,
        "export default { test: { include: ['*.test.ts'], exclude: ['excluded.test.ts'] } }",
      );
      for (const file of ["one.test.ts", "excluded.test.ts", "other.e2e.ts"]) {
        writeFileSync(
          path.join(cwd, file),
          "throw new Error('Discovery must never evaluate tests')",
        );
      }
      const input = {
        root: path.resolve(import.meta.dirname, ".."),
        cwd,
        config,
      };
      expect(discoverTestFiles(input)).toBe(1);
      writeFileSync(
        path.join(cwd, "new.test.ts"),
        "throw new Error('Do not import')",
      );
      expect(discoverTestFiles(input)).toBe(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
