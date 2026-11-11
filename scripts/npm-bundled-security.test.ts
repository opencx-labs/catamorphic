import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { toolRuntime } from "./tool-runtime.js";

interface BundledMinimatch {
  Minimatch: new (
    pattern: string,
    options?: { optimizationLevel?: number; braceExpandMax?: number },
  ) => { set: unknown[][]; match: (value: string) => boolean };
}
interface GlobOptions {
  cwd?: string;
  signal?: AbortSignal;
  fs?: object;
  braceExpandMax?: number;
}
interface BundledGlob {
  Glob: new (pattern: string, options: GlobOptions) => { patterns: unknown[] };
  glob: (pattern: string, options: GlobOptions) => Promise<string[]>;
  globSync: (pattern: string, options: GlobOptions) => string[];
  globStream: (pattern: string, options: GlobOptions) => AsyncIterable<string>;
  globStreamSync: (
    pattern: string,
    options: GlobOptions,
  ) => {
    on: (event: "error", callback: (error: Error) => void) => unknown;
    resume: () => unknown;
  };
}

const rootPath = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const npmPath = require.resolve("npm/package.json");
const npmRequire = createRequire(npmPath);
const globRoot = path.dirname(npmRequire.resolve("glob/package.json"));
const minimatchRoot = path.dirname(
  npmRequire.resolve("minimatch/package.json"),
);
const cjsGlob: BundledGlob = npmRequire("glob");
const cjsRawGlob: BundledGlob = npmRequire("glob/raw");
const esmGlob: BundledGlob = await import(
  pathToFileURL(path.join(globRoot, "dist/esm/index.min.js")).href
);
const esmRawGlob: BundledGlob = await import(
  pathToFileURL(path.join(globRoot, "dist/esm/index.js")).href
);
const cjsMinimatch: BundledMinimatch = npmRequire("minimatch");
const esmMinimatch: BundledMinimatch = await import(
  pathToFileURL(path.join(minimatchRoot, "dist/esm/index.js")).href
);

it("loads npm's physical bundles instead of overridden root dependencies", () => {
  const npmManifest: { version: string } = npmRequire("./package.json");
  expect(npmManifest.version).toBe("12.2.2");
  for (const directory of [globRoot, minimatchRoot])
    expect(directory.startsWith(`${path.dirname(npmPath)}/node_modules/`)).toBe(
      true,
    );
});

function tree(directory: string, depth: number): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "file.txt"), "test");
  if (depth === 0) return;
  tree(path.join(directory, "a"), depth - 1);
  tree(path.join(directory, "b"), depth - 1);
}

for (const { name, matcher } of [
  { name: "CommonJS", matcher: cjsMinimatch },
  { name: "ESM", matcher: esmMinimatch },
]) {
  describe(`npm's actual bundled minimatch (${name})`, () => {
    it("bounds globstar/parent preprocessing with the upstream cap", () => {
      const pattern = Array(8).fill("**/../a/b").join("/");
      const mm = new matcher.Minimatch(pattern, {
        optimizationLevel: 2,
        braceExpandMax: 16,
      });
      expect(mm.set).toHaveLength(16);
    });

    it("skips quadratic deduplication of large sets while preserving matches", () => {
      const mm = new matcher.Minimatch("{x,*}/{0..999}", {
        optimizationLevel: 2,
      });
      expect(mm.set).toHaveLength(2000);
      expect(mm.match("x/5")).toBe(true);
      expect(mm.match("y/999")).toBe(true);
      expect(mm.match(".y/5")).toBe(false);
      const small = new matcher.Minimatch("{x,*}/{0..9}", {
        optimizationLevel: 2,
      });
      expect(small.set).toHaveLength(10);
    });
  });
}

for (const { name, glob } of [
  { name: "CommonJS public", glob: cjsGlob },
  { name: "ESM public", glob: esmGlob },
  { name: "CommonJS raw", glob: cjsRawGlob },
  { name: "ESM raw", glob: esmRawGlob },
]) {
  describe(`npm's actual bundled glob (${name})`, () => {
    it("uses the capped matcher rather than an unpatched embedded copy", () => {
      const compiled = new glob.Glob(Array(8).fill("**/../a/b").join("/"), {
        braceExpandMax: 16,
      });
      expect(compiled.patterns).toHaveLength(16);
    });

    it("does not continue filesystem reads after asynchronous cancellation", async () => {
      const directory = fs.mkdtempSync(path.join(tmpdir(), "npm-glob-abort-"));
      tree(directory, 4);
      const controller = new AbortController();
      const reason = new Error("test cancellation");
      const reads = vi.fn();
      const countedFs = {
        ...fs,
        readdir(...args: Parameters<typeof fs.readdir>) {
          reads();
          if (reads.mock.calls.length === 1) controller.abort(reason);
          return fs.readdir(...args);
        },
      };
      try {
        await expect(
          glob.glob("**", {
            cwd: directory,
            signal: controller.signal,
            fs: countedFs,
          }),
        ).rejects.toBe(reason);
        // Pending directory callbacks must not start new traversal after rejection.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(reads).toHaveBeenCalledTimes(1);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });

    it("stops synchronous stream reads at cancellation", async () => {
      const directory = fs.mkdtempSync(path.join(tmpdir(), "npm-glob-stream-"));
      tree(directory, 4);
      const controller = new AbortController();
      const reason = new Error("test cancellation");
      const reads = vi.fn();
      const countedFs = {
        ...fs,
        readdirSync(...args: Parameters<typeof fs.readdirSync>) {
          reads();
          if (reads.mock.calls.length === 1) controller.abort(reason);
          return fs.readdirSync(...args);
        },
      };
      try {
        const failed = new Promise<Error>((resolve) => {
          const stream = glob.globStreamSync("**", {
            cwd: directory,
            signal: controller.signal,
            fs: countedFs,
          });
          stream.on("error", resolve);
          stream.resume();
        });
        await expect(failed).resolves.toBe(reason);
        expect(reads).toHaveBeenCalledTimes(1);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });

    it("preserves ordinary asynchronous and synchronous file matching", async () => {
      const directory = fs.mkdtempSync(path.join(tmpdir(), "npm-glob-match-"));
      try {
        fs.mkdirSync(path.join(directory, "nested"));
        fs.writeFileSync(path.join(directory, "one.txt"), "one");
        fs.writeFileSync(path.join(directory, "nested/two.txt"), "two");
        fs.writeFileSync(path.join(directory, "nested/skip.js"), "skip");
        const expected = ["nested/two.txt", "one.txt"];
        expect(glob.globSync("**/*.txt", { cwd: directory }).sort()).toEqual(
          expected,
        );
        expect(
          (await glob.glob("**/*.txt", { cwd: directory })).sort(),
        ).toEqual(expected);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });

    it("preserves streams paused while directory reads are pending", async () => {
      const directory = fs.mkdtempSync(path.join(tmpdir(), "npm-glob-resume-"));
      tree(directory, 5);
      try {
        const stream = glob.globStream("**", { cwd: directory });
        await new Promise((resolve) => setTimeout(resolve, 50));
        const found: string[] = [];
        for await (const file of stream) found.push(file);
        expect(found.sort()).toEqual(
          glob.globSync("**", { cwd: directory }).sort(),
        );
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  });
}

it("runs the pinned npm's real pack and install paths without network or credentials", () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "npm-bundle-smoke-"));
  const source = path.join(directory, "source");
  const consumer = path.join(directory, "consumer");
  const config = path.join(directory, "empty.npmrc");
  const globalConfig = path.join(directory, "global.npmrc");
  const runtime = toolRuntime({
    rootPath,
    env: {
      PATH: process.env.PATH,
      npm_config_userconfig: config,
      npm_config_globalconfig: globalConfig,
      npm_config_cache: path.join(directory, "cache"),
      npm_config_offline: "true",
      npm_config_registry: "http://127.0.0.1:9",
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
  });
  const npm = (cwd: string, args: string[]) =>
    execFileSync(
      runtime.nodePath,
      [path.join(path.dirname(npmPath), "bin/npm-cli.js"), ...args],
      { cwd, env: runtime.env, encoding: "utf8", timeout: 20_000 },
    );
  try {
    fs.mkdirSync(path.join(source, "dist"), { recursive: true });
    fs.mkdirSync(consumer);
    fs.writeFileSync(config, "");
    fs.writeFileSync(globalConfig, "");
    fs.writeFileSync(
      path.join(source, "package.json"),
      JSON.stringify({
        name: "npm-security-fixture",
        version: "1.0.0",
        type: "module",
        main: "dist/index.js",
        files: ["dist/*.js"],
      }),
    );
    fs.writeFileSync(
      path.join(source, "dist/index.js"),
      "export const value = 42;",
    );
    fs.writeFileSync(
      path.join(source, "excluded.txt"),
      "synthetic private content",
    );
    const packed: Record<
      string,
      { filename: string; files: { path: string }[] }
    > = JSON.parse(npm(source, ["pack", "--json", "--ignore-scripts"]));
    const archive = packed["npm-security-fixture"];
    if (!archive) throw new Error("npm did not produce an archive");
    expect(archive.files.map((file) => file.path).sort()).toEqual([
      "dist/index.js",
      "package.json",
    ]);
    fs.writeFileSync(path.join(consumer, "package.json"), '{"private":true}');
    npm(consumer, [
      "install",
      path.join(source, archive.filename),
      "--ignore-scripts",
      "--package-lock=false",
    ]);
    expect(
      execFileSync(
        runtime.nodePath,
        [
          "--input-type=module",
          "-e",
          'import { value } from "npm-security-fixture"; console.log(value);',
        ],
        { cwd: consumer, env: runtime.env, encoding: "utf8" },
      ).trim(),
    ).toBe("42");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
