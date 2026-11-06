import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergePaths, readLoginShellPath } from "./login-shell-path.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const LOGIN = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

/**
 * A stand-in login shell: `<shell> -ilc <command>` runs its profile, then
 * the command. Like an interactive shell, it ignores SIGTERM.
 */
async function shell(profile: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "login-shell-"));
  roots.push(root);
  const file = path.join(root, "shell");
  await fs.writeFile(
    file,
    `#!/bin/sh\ntrap '' TERM\n${profile}\nPATH=${LOGIN}\nexport PATH\neval "$2"\n`,
  );
  await fs.chmod(file, 0o755);
  return file;
}

describe.skipIf(process.platform === "win32")("login shell PATH", () => {
  it("reads the PATH a login shell exports, past whatever its profile prints", async () => {
    // A banner, a stray path, and a title escape with no newline after it.
    const file = await shell(
      `echo "Welcome back"; echo "/not/a/path"; printf '\\033]0;title\\007'`,
    );
    expect(await readLoginShellPath({ shell: file })).toBe(LOGIN);
  });

  it("does not wait on a profile that asks a question", async () => {
    const file = await shell(
      'printf "Update now? [Y/n] "; read answer; echo "answered: $answer"',
    );
    const started = Date.now();
    expect(await readLoginShellPath({ shell: file, timeoutMs: 4000 })).toBe(
      LOGIN,
    );
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("answers as soon as it is printed, past a job the profile leaves running", async () => {
    const file = await shell("(sleep 30) &");
    const started = Date.now();
    expect(await readLoginShellPath({ shell: file, timeoutMs: 4000 })).toBe(
      LOGIN,
    );
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("gives up on a profile that hangs, whatever signal it ignores, and on a shell that cannot start", async () => {
    const file = await shell("sleep 30");
    const started = Date.now();
    expect(
      await readLoginShellPath({ shell: file, timeoutMs: 300 }),
    ).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(
      await readLoginShellPath({ shell: path.join(os.tmpdir(), "no-shell") }),
    ).toBeUndefined();
  });
});

describe("mergePaths", () => {
  it("puts the login shell first for an app started from the Dock", () => {
    expect(
      mergePaths({
        current: "/usr/bin:/bin:/usr/sbin:/sbin",
        login: LOGIN,
        loginFirst: true,
      }),
    ).toBe("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  });

  it("keeps a terminal-started app's order and adds only what is missing", () => {
    expect(
      mergePaths({
        current: "/dev/node/bin:/usr/bin:/bin",
        login: LOGIN,
        loginFirst: false,
      }),
    ).toBe("/dev/node/bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin");
  });

  it("keeps only absolute entries, and the current PATH when the shell had nothing", () => {
    expect(
      mergePaths({
        current: "/usr/bin:/bin",
        login: ".:node_modules/.bin:/opt/homebrew/bin",
        loginFirst: true,
      }),
    ).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(
      mergePaths({ current: "/usr/bin:/bin", login: "", loginFirst: true }),
    ).toBe("/usr/bin:/bin");
  });
});
