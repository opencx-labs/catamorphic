import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const micromatch: {
  matcher: (
    pattern: string,
    options?: { nocase?: boolean },
  ) => (value: string) => boolean;
} = require(path.join(root, "vendor/micromatch"));
const sprintfJs: {
  sprintf: (format: string, ...values: unknown[]) => string;
  vsprintf: (format: string, values: unknown[]) => string;
} = require(path.join(root, "vendor/sprintf-js"));

describe("vendor stand-ins", () => {
  it("replace the real packages through the root overrides", () => {
    const manifest: { overrides: Record<string, string> } = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    );
    expect(manifest.overrides.micromatch).toBe("file:./vendor/micromatch");
    expect(manifest.overrides["sprintf-js"]).toBe("file:./vendor/sprintf-js");
    const lock = readFileSync(path.join(root, "bun.lock"), "utf8");
    for (const name of ["braces", "micromatch", "sprintf-js"])
      expect(lock).not.toMatch(new RegExp(`"${name}@\\d`));
  });

  it("match kysely-codegen's table patterns the way micromatch does", () => {
    // db:codegen passes --include-pattern 'catamorphic.*' with nocase.
    const tables = micromatch.matcher("catamorphic.*", { nocase: true });
    expect(tables("catamorphic.agent_sessions")).toBe(true);
    expect(tables("Catamorphic.Runs")).toBe(true);
    expect(tables("public.users")).toBe(false);
    expect(tables("catamorphicXagent_sessions")).toBe(false);
    expect(micromatch.matcher("agent_?essions")("agent_sessions")).toBe(true);
    expect(micromatch.matcher("{runs,deployments}")("deployments")).toBe(true);
    expect(micromatch.matcher("{runs,deployments}")("runsdeployments")).toBe(
      false,
    );
    expect(micromatch.matcher("a*")("a/b")).toBe(false);
    expect(micromatch.matcher("a(b)+")("a(b)+")).toBe(true);
    expect(micromatch.matcher("Runs")("runs")).toBe(false);
    expect(() => micromatch.matcher("{runs")).toThrow("Unclosed");
  });

  it("format roarr's messages the way sprintf-js does", () => {
    expect(sprintfJs.sprintf("%s", "request error")).toBe("request error");
    expect(sprintfJs.sprintf("%d of %s, %j", "42.9", "two", { a: 1 })).toBe(
      '42 of two, {"a":1}',
    );
    expect(sprintfJs.sprintf("%f%% %i", "1.5", 7)).toBe("1.5% 7");
    expect(sprintfJs.vsprintf("%s and %s", ["one"])).toBe("one and %s");
    // No widths or precisions: a hostile format cannot inflate the output.
    expect(sprintfJs.sprintf("%.999999999f", 1)).toBe("%.999999999f");
  });
});
