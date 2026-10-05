import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { formatEnvFile, parseEnvFile, shellSingleQuote } from "../env-file.js";

const execute = promisify(execFile);

/*
 * The environment file a sandbox's shells and runner load (ADR 0205): the
 * parser reads back exactly what the writer wrote, and a shell sourcing it
 * sees the same values.
 */

const VARIABLES = {
  PLAIN: "sk-live-123",
  QUOTES: `it's "quoted" and \\ escaped`,
  LINES: "line one\nline two\n",
  SHELLY: "$(touch pwned) `id` $HOME ; | &&",
  EMPTY: "",
  UNICODE: "café ✓",
};

describe("environment files", () => {
  it("round-trips any value", () => {
    expect(parseEnvFile(formatEnvFile(VARIABLES))).toEqual(VARIABLES);
  });

  it("is what a shell reads, without running anything in it", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "env-file-"));
    try {
      const file = path.join(directory, "secrets.sh");
      await fs.writeFile(file, formatEnvFile(VARIABLES));
      const { stdout } = await execute(
        "/bin/sh",
        [
          "-c",
          `. ${shellSingleQuote(file)} && for name in ${Object.keys(VARIABLES).join(" ")}; do eval "printf '%s\\0' \\"\\$$name\\""; done`,
        ],
        { cwd: directory, env: { PATH: process.env.PATH ?? "" } },
      );
      expect(stdout.split("\0").slice(0, -1)).toEqual(Object.values(VARIABLES));
      await expect(fs.stat(path.join(directory, "pwned"))).rejects.toThrow();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("skips lines it did not write and refuses names it cannot", () => {
    expect(
      parseEnvFile(
        [
          "# a comment",
          "",
          "A=unquoted",
          "export B='ok'",
          "export D='also ok'",
          "export C='unterminated",
        ].join("\n"),
      ),
    ).toEqual({ B: "ok", D: "also ok" });
    expect(() => formatEnvFile({ "NOT-A-NAME": "x" })).toThrow(
      "not an environment variable name",
    );
  });
});
