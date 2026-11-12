import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

type Zod3 = typeof import("zod/v3");

const require = createRequire(import.meta.url);
const sandboxRequire = createRequire(
  require.resolve("@anthropic-ai/sandbox-runtime/package.json"),
);
const packagePath = sandboxRequire.resolve("zod/package.json");
const packageRoot = path.dirname(packagePath);
const installed: { version: string } = sandboxRequire("zod/package.json");
const esm: Zod3 = await import(
  pathToFileURL(path.join(packageRoot, "v3/index.js")).href
);
const commonjs: Zod3 = sandboxRequire(path.join(packageRoot, "v3/index.cjs"));

for (const { name, z } of [
  { name: "ESM", z: esm.z },
  { name: "CommonJS", z: commonjs.z },
]) {
  describe(`patched Zod 3 collection bounds (${name})`, () => {
    it("exercises sandbox-runtime's actual v3 dependency", () => {
      expect(installed.version).toBe("3.25.76");
    });

    for (const exact of [false, true]) {
      it(`rejects an oversized array ${exact ? "length" : "maximum"} before enumeration or child parsing`, () => {
        const child = vi.fn((value: unknown) => value);
        const refined = vi.fn(() => true);
        const array = z.array(z.preprocess(child, z.string()));
        const schema = z.object({
          items: (exact
            ? array.length(2, "array cap")
            : array.max(2, "array cap")
          ).refine(refined),
        });
        const values = new Array(1_000_000);
        Object.defineProperty(values, Symbol.iterator, {
          value() {
            throw new Error("Oversized array must not be enumerated");
          },
        });
        const result = schema.safeParse({ items: values });
        expect(result.success).toBe(false);
        expect(result.error?.issues).toStrictEqual([
          {
            code: "too_big",
            ...(exact ? { minimum: undefined } : {}),
            maximum: 2,
            type: "array",
            inclusive: true,
            exact,
            message: "array cap",
            path: ["items"],
          },
        ]);
        expect(child).not.toHaveBeenCalled();
        expect(refined).not.toHaveBeenCalled();
      });

      it(`rejects an oversized set ${exact ? "size" : "maximum"} before enumeration or child parsing`, () => {
        const child = vi.fn((value: unknown) => value);
        const refined = vi.fn(() => true);
        const set = z.set(z.preprocess(child, z.string()));
        const schema = z.object({
          items: (exact
            ? set.size(2, "set cap")
            : set.max(2, "set cap")
          ).refine(refined),
        });
        const values = new Set(["one", "two", "three"]);
        Object.defineProperty(values, "values", {
          value() {
            throw new Error("Oversized set must not be enumerated");
          },
        });
        const result = schema.safeParse({ items: values });
        expect(result.success).toBe(false);
        expect(result.error?.issues).toStrictEqual([
          {
            code: "too_big",
            maximum: 2,
            type: "set",
            inclusive: true,
            exact: false,
            message: "set cap",
            path: ["items"],
          },
        ]);
        expect(child).not.toHaveBeenCalled();
        expect(refined).not.toHaveBeenCalled();
      });
    }

    it("does not start asynchronous child parsers on oversized collections", async () => {
      const child = vi.fn(async (value: unknown) => value);
      const item = z.preprocess(child, z.string());
      for (const schema of [z.array(item).max(1), z.array(item).length(1)]) {
        const result = await schema.safeParseAsync(["one", "two"]);
        expect(result.success).toBe(false);
        expect(result.error?.issues).toHaveLength(1);
      }
      for (const schema of [z.set(item).max(1), z.set(item).size(1)]) {
        const result = await schema.safeParseAsync(new Set(["one", "two"]));
        expect(result.success).toBe(false);
        expect(result.error?.issues).toHaveLength(1);
      }
      expect(child).not.toHaveBeenCalled();
    });

    it("preserves valid synchronous transformations at the size boundary", () => {
      const item = z.string().transform((value) => value.toUpperCase());
      expect(z.array(item).length(2).parse(["one", "two"])).toEqual([
        "ONE",
        "TWO",
      ]);
      expect(
        z
          .set(item)
          .size(2)
          .parse(new Set(["one", "two"])),
      ).toEqual(new Set(["ONE", "TWO"]));
      expect(z.array(item).max(0).parse([])).toEqual([]);
      expect(z.set(item).max(0).parse(new Set())).toEqual(new Set());
    });

    it("preserves valid asynchronous transformations", async () => {
      const item = z.string().transform(async (value) => value.toUpperCase());
      await expect(
        z.array(item).max(2).parseAsync(["one", "two"]),
      ).resolves.toEqual(["ONE", "TWO"]);
      await expect(
        z
          .set(item)
          .max(2)
          .parseAsync(new Set(["one", "two"])),
      ).resolves.toEqual(new Set(["ONE", "TWO"]));
    });

    it("preserves both size and child diagnostics for undersized collections", () => {
      const array = z.array(z.string()).length(2).safeParse([1]);
      const set = z
        .set(z.string())
        .size(2)
        .safeParse(new Set([1]));
      for (const result of [array, set]) {
        expect(result.success).toBe(false);
        expect(result.error?.issues).toMatchObject([
          { code: "too_small", minimum: 2, inclusive: true },
          { code: "invalid_type", expected: "string", path: [0] },
        ]);
      }
    });

    it("preserves collection type errors", () => {
      const array = z.array(z.string()).max(1).safeParse("invalid");
      const set = z.set(z.string()).max(1).safeParse(["one"]);
      expect(array.error?.issues).toMatchObject([
        { code: "invalid_type", expected: "array", received: "string" },
      ]);
      expect(set.error?.issues).toMatchObject([
        { code: "invalid_type", expected: "set", received: "array" },
      ]);
    });
  });
}
