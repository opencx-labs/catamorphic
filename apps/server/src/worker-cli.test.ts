import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `work worker sign-in`, `sign-out` and `sign-ins` for both harnesses (ADRs
 * 0199, 0213, 0342), run as the image runs them. `claude` is a stand-in
 * that speaks `claude auth login`: nothing here reaches Anthropic.
 */

/** What a member pastes from the stand-in's sign-in page. */
const CLAUDE_CODE = "TEST-CLAUDE-CODE#state";

let root = "";
let bin = "";
let dataDir = "";

function work(args: readonly string[], input = "") {
  const result = spawnSync(
    "bun",
    [path.join(import.meta.dirname, "worker.ts"), ...args],
    {
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        WORK_DATA_DIR: dataDir,
        // An organization's key on the machine is not the member's sign-in:
        // the stand-in refuses a login that is handed one.
        ANTHROPIC_API_KEY: "sk-ant-organization",
      },
      input,
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

const credentials = (member: string) =>
  path.join(dataDir, "sign-ins", "claude-code", member, ".credentials.json");

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "work-worker-cli-"));
  bin = path.join(root, "bin");
  dataDir = path.join(root, "data");
  fs.mkdirSync(bin);
  fs.copyFileSync(
    path.join(
      import.meta.dirname,
      "../../../packages/work-server/src/workers/fake-claude-cli.ts",
    ),
    path.join(bin, "claude"),
  );
  fs.chmodSync(path.join(bin, "claude"), 0o755);
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("work worker sign-in", () => {
  it("runs Claude Code's own login in the terminal, into the member's home", () => {
    const signedIn = work(
      ["sign-in", "claude-code", "--member", "alice"],
      `${CLAUDE_CODE}\n`,
    );
    expect(signedIn.output).toContain(
      "Signing alice in to Claude Code on this machine.",
    );
    // The login's own words reach the terminal: its link and its prompt.
    expect(signedIn.output).toContain("visit: https://claude.com/");
    expect(signedIn.output).toContain(
      "Done. alice's Claude Code sign-in is in",
    );
    expect(signedIn.status).toBe(0);
    expect(fs.existsSync(credentials("alice"))).toBe(true);
    expect(fs.statSync(credentials("alice")).mode & 0o777).toBe(0o600);
    expect(work(["sign-ins"]).output.trim()).toBe("claude-code\talice");
  }, 120_000);

  it("keeps the sign-in when a later login fails, and holds one person's only", () => {
    const before = fs.readFileSync(credentials("alice"), "utf8");
    const wrong = work(
      ["sign-in", "claude-code", "--member", "alice"],
      "not-the-code\n",
    );
    expect(wrong.status).toBe(1);
    expect(wrong.output).toContain("The Claude Code login exited with 1.");
    expect(fs.readFileSync(credentials("alice"), "utf8")).toBe(before);

    // Someone else's login, of either harness, never starts here.
    for (const harness of ["claude-code", "codex"]) {
      const held = work(
        ["sign-in", harness, "--member", "bob"],
        `${CLAUDE_CODE}\n`,
      );
      expect(held.status).toBe(1);
      expect(held.output).toContain(
        "Another person's sign-in is on this machine, and a machine holds one person's only.",
      );
      expect(held.output).not.toContain("visit:");
    }
    expect(fs.existsSync(credentials("bob"))).toBe(false);
  }, 120_000);

  it("signs out, lists, and names both harnesses in its usage", () => {
    expect(
      work(["sign-out", "claude-code", "--member", "alice"]).output.trim(),
    ).toBe("Signed alice out of Claude Code on this machine.");
    expect(work(["sign-out", "codex", "--member", "alice"]).output.trim()).toBe(
      "alice was not signed in to Codex on this machine.",
    );
    expect(work(["sign-ins"]).output.trim()).toBe(
      "No one is signed in on this machine.",
    );
    const unknown = work(["sign-in", "emacs", "--member", "alice"]);
    expect(unknown.status).toBe(2);
    expect(unknown.output).toContain(
      "work worker sign-in <claude-code|codex> --member <id>",
    );
    // Nothing a person reads carries a dash.
    expect(work(["help"]).output).not.toMatch(/[–—]/);
  }, 120_000);
});
