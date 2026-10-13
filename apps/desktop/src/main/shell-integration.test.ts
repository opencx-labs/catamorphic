import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanOsc133 } from "../shared/terminal-text.js";
import { shellIntegration } from "./shell-integration.js";

/** A bash with PS0 (4.4+) on this machine, if any: macOS ships 3.2. */
function modernBash(): string | undefined {
  for (const candidate of [
    "/bin/bash",
    "/usr/bin/bash",
    "/usr/local/bin/bash",
    "/opt/homebrew/bin/bash",
  ]) {
    try {
      const [major = 0, minor = 0] = execFileSync(
        candidate,
        ["-c", 'echo "${BASH_VERSINFO[0]} ${BASH_VERSINFO[1]}"'],
        { encoding: "utf8" },
      )
        .trim()
        .split(" ")
        .map(Number);
      if (major > 4 || (major === 4 && minor >= 4)) return candidate;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

const bash = modernBash();

describe("shell integration for agent terminals", () => {
  it("starts zsh as a login shell through its ZDOTDIR shim", async () => {
    const zsh = await shellIntegration("/bin/zsh");
    expect(zsh?.args).toEqual(["-l"]);
    expect(zsh?.env.ZDOTDIR).toBeTruthy();
  });

  it("starts bash with an init file that reads the login profile first", async () => {
    const integrated = await shellIntegration("/usr/bin/bash");
    expect(integrated?.args[0]).toBe("--init-file");
    const init = fs.readFileSync(integrated?.args[1] ?? "", "utf8");
    // bash -l reads no init file, so the shim reads the profile itself,
    // in bash's own order, before adding its hooks.
    expect(init.indexOf("/etc/profile")).toBeLessThan(init.indexOf("PS0="));
    expect(init).toContain('"$HOME/.bash_profile" "$HOME/.bash_login"');
    expect(init).toContain("\\e]133;C\\a");
    expect(init).toContain("\\e]133;D;%s\\a");
  });

  it("leaves other shells to the foreground-process heuristic", async () => {
    expect(await shellIntegration("/usr/bin/fish")).toBeNull();
  });

  it.skipIf(!bash)(
    "marks a command's start and its end once in a real bash, however it runs between its steps",
    async () => {
      const { spawn } = await import("@lydell/node-pty");
      const integrated = await shellIntegration(bash ?? "");
      if (!integrated) throw new Error("bash was not integrated");
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "bash-home-"));
      // The person's own prompt hook keeps running beside Work's.
      fs.writeFileSync(
        path.join(home, ".bash_profile"),
        "PROMPT_COMMAND='printf \"[own hook]\"'\n",
      );
      const pty = spawn(bash ?? "", integrated.args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: home,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          TERM: "xterm",
          HISTFILE: "/dev/null",
        },
      });
      const exited = new Promise<void>((resolve) =>
        pty.onExit(() => resolve()),
      );
      const markers: string[] = [];
      let carry = "";
      let output = "";
      pty.onData((data) => {
        output += data;
        carry = scanOsc133(carry + data, (marker) => {
          markers.push(
            marker.kind === "D" ? `D${marker.exitCode ?? ""}` : marker.kind,
          );
        });
      });
      const until = async (check: () => boolean) => {
        const deadline = Date.now() + 10_000;
        while (!check() && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 20));
        if (!check()) throw new Error(`Timed out; markers: ${markers}`);
      };
      try {
        // The first prompt: a D with nothing run behind it.
        await until(() => markers.includes("D0"));
        const before = markers.length;
        pty.write("sleep 0.3; for i in 1 2 3; do sleep 0.2; done; false\r");
        await until(() => markers.slice(before).includes("D1"));
        // One start, one end with its exit code: the loop's steps between
        // its sleeps are no end.
        expect(markers.slice(before)).toEqual(["C", "D1"]);
        expect(output).toContain("[own hook]");
      } finally {
        pty.kill();
        await exited;
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
