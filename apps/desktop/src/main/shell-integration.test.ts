import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanOsc133 } from "../shared/terminal-text.js";
import { shellIntegration } from "./shell-integration.js";

function bashVersion(candidate: string): [number, number] | undefined {
  try {
    const version = execFileSync(candidate, ["-c", 'echo "$BASH_VERSION"'], {
      encoding: "utf8",
    });
    const [, major = 0, minor = 0] =
      /^(\d+)\.(\d+)/.exec(version.trim())?.map(Number) ?? [];
    return [major, minor];
  } catch {
    return undefined;
  }
}

/** A bash before 4.4 on this machine, if any: macOS ships 3.2. */
function oldBash(): string | undefined {
  return ["/bin/bash", "/usr/bin/bash"].find((candidate) => {
    const version = bashVersion(candidate);
    return version && (version[0] < 4 || (version[0] === 4 && version[1] < 4));
  });
}

/** A bash with PS0 (4.4+) on this machine, if any. */
function modernBash(): string | undefined {
  for (const candidate of [
    "/bin/bash",
    "/usr/bin/bash",
    "/usr/local/bin/bash",
    "/opt/homebrew/bin/bash",
  ]) {
    const [major, minor] = bashVersion(candidate) ?? [0, 0];
    if (major > 4 || (major === 4 && minor >= 4)) return candidate;
  }
  return undefined;
}

const bash = modernBash();
const bash3 = oldBash();

describe("shell integration for agent terminals", () => {
  it("starts zsh as a login shell through its ZDOTDIR shim", async () => {
    const zsh = await shellIntegration("/bin/zsh");
    expect(zsh?.args).toEqual(["-l"]);
    expect(zsh?.env.ZDOTDIR).toBeTruthy();
  });

  it.skipIf(!bash)(
    "starts bash with an init file that reads the login profile first",
    async () => {
      const integrated = await shellIntegration(bash ?? "");
      expect(integrated?.args[0]).toBe("--init-file");
      const file = integrated?.args[1] ?? "";
      const init = fs.readFileSync(file, "utf8");
      // bash -l reads no init file, so the shim reads the profile itself,
      // in bash's own order, before adding its hooks.
      expect(init.indexOf("/etc/profile")).toBeLessThan(init.indexOf("PS0="));
      expect(init).toContain('"$HOME/.bash_profile" "$HOME/.bash_login"');
      expect(init).toContain("\\e]133;C\\a");
      expect(init).toContain("\\e]133;D;%s\\a");
      // Private to this user: nobody else can plant it.
      expect(fs.statSync(path.dirname(path.dirname(file))).mode & 0o077).toBe(
        0,
      );
    },
  );

  it.skipIf(!bash3)(
    "leaves a bash without PS0 (before 4.4) a plain login shell",
    async () => {
      expect(await shellIntegration(bash3 ?? "")).toBeNull();
    },
  );

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
          // The person's own prompt hook keeps running beside Work's. It
          // rides the environment: a machine's own profile (a CI runner's
          // resets HOME) decides which ~/.bash_profile a login reads.
          PROMPT_COMMAND: 'printf "[own hook]"',
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
        // The person's hook runs first; the end comes once the prompt is
        // theirs, right before it shows.
        const ran = output.lastIndexOf("\u001b]133;C");
        expect(output.indexOf("[own hook]", ran)).toBeGreaterThan(ran);
        expect(output.indexOf("[own hook]", ran)).toBeLessThan(
          output.indexOf("\u001b]133;D;1", ran),
        );
        // The exported PROMPT_COMMAND stays this shell's: a nested shell
        // never runs hooks it does not have.
        const nested = markers.length;
        pty.write("bash -i\r");
        pty.write("echo nested-$((40 + 2)); exit\r");
        await until(
          () =>
            output.includes("nested-42") &&
            markers.slice(nested).includes("D0"),
        );
        expect(output).not.toContain("command not found");
      } finally {
        pty.kill();
        await exited;
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
