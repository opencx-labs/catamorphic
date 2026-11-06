import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JsonObject } from "@catamorphic/agent-protocol";
import { describe, expect, it } from "vitest";
import { scanOsc133 } from "../shared/terminal-text.js";
import {
  agentShellEnvFile,
  codexShellEnvironment,
  shellIntegration,
  withAgentShellOptions,
} from "./shell-integration.js";

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
const zsh = ["/bin/zsh", "/usr/bin/zsh"].find((candidate) =>
  fs.existsSync(candidate),
);

/** What `args` print to stdout in `shell`. */
function run(shell: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync(shell, args, { encoding: "utf8", env }).trim();
}

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

  it.skipIf(!zsh)(
    "passes a pattern that matches nothing through, as bash does, in an agent's zsh",
    async () => {
      const integrated = await shellIntegration(zsh ?? "");
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "zsh-home-"));
      // The person's own .zshrc runs first and keeps the rest of its say.
      fs.writeFileSync(
        path.join(home, ".zshrc"),
        "setopt nomatch null_glob\nexport OWN_RC=ran\n",
      );
      try {
        // A pattern with no match fails the whole command in plain zsh.
        expect(() =>
          execFileSync(zsh ?? "", ["-c", "echo --include=*.zzz"], {
            cwd: home,
            stdio: "pipe",
            env: { PATH: process.env.PATH ?? "", HOME: home },
          }),
        ).toThrow(/no matches found/);
        expect(
          run(zsh ?? "", ["-i", "-c", 'echo --include=*.zzz "$OWN_RC"'], {
            PATH: process.env.PATH ?? "",
            HOME: home,
            ...integrated?.env,
            USER_ZDOTDIR: home,
          }),
        ).toBe("--include=*.zzz ran");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!zsh)(
    "gives native harnesses a file that sets the same option ahead of each command",
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-env-"));
      const own = path.join(home, "it's mine.sh");
      fs.writeFileSync(own, "export OWN_SETUP=ran\n");
      const previous = process.env.CLAUDE_ENV_FILE;
      process.env.CLAUDE_ENV_FILE = own;
      try {
        const file = (await agentShellEnvFile()) ?? "";
        const env = { PATH: process.env.PATH ?? "", HOME: home };
        // Claude Code's snapshot carries the person's own options.
        expect(
          run(
            zsh ?? "",
            ["-c", `setopt null_glob; . '${file}'; echo --include=*.zzz`],
            env,
          ),
        ).toBe("--include=*.zzz");
        // A file the person set for themselves still runs, first.
        expect(
          run(zsh ?? "", ["-c", `. '${file}'; echo "$OWN_SETUP"`], env),
        ).toBe("ran");
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_ENV_FILE;
        else process.env.CLAUDE_ENV_FILE = previous;
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("keeps the harness file read-only, and a no-op that succeeds in any other shell", async () => {
    const file = (await agentShellEnvFile()) ?? "";
    // Every chat's Claude Code reads it: nothing appends to it (root, as a
    // CI container may run, ignores the mode).
    expect(fs.statSync(file).mode & 0o777).toBe(0o400);
    if (process.getuid?.() !== 0)
      expect(() =>
        execFileSync("/bin/sh", ["-c", `echo 'export X=1' >> '${file}'`], {
          stdio: "pipe",
        }),
      ).toThrow();
    expect(run("/bin/sh", ["-c", `. '${file}' && echo ok`], {})).toBe("ok");
    // Written again for the next attempt over the read-only one.
    expect(await agentShellEnvFile()).toBe(file);
  });

  it("adds the options only to a zsh command: fish could not parse them", () => {
    expect(withAgentShellOptions("ls *.ts", "/bin/zsh")).toBe(
      "setopt no_nomatch no_null_glob no_csh_null_glob\nls *.ts",
    );
    for (const shell of ["/opt/homebrew/bin/fish", "/bin/bash", "/bin/sh"])
      expect(withAgentShellOptions("ls *.ts", shell)).toBe("ls *.ts");
  });

  it.skipIf(!zsh)(
    "applies Codex's options after each original startup file, without changing the person's files",
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-dotfiles-"));
      const own = path.join(home, "my dotfiles");
      fs.mkdirSync(own);
      const files = [".zshenv", ".zprofile", ".zshrc", ".zlogin"];
      const content = `export OWN_STARTUP="\${OWN_STARTUP}x"\nsetopt nomatch null_glob csh_null_glob\n`;
      for (const file of files) fs.writeFileSync(path.join(own, file), content);
      const env = { PATH: process.env.PATH ?? "", HOME: home, ZDOTDIR: own };
      try {
        const integrated = await codexShellEnvironment({ env, config: {} });
        expect(integrated).not.toBeNull();
        for (const file of files)
          expect(
            fs.statSync(path.join(integrated?.ZDOTDIR ?? "", file)).mode &
              0o777,
          ).toBe(0o400);
        for (const { args, startup } of [
          { args: ["-c"], startup: "x" },
          { args: ["-l", "-c"], startup: "xxx" },
          { args: ["-l", "-i", "-c"], startup: "xxxx" },
        ]) {
          expect(
            run(zsh ?? "", [...args, 'echo --include=*.zzz "$OWN_STARTUP"'], {
              ...env,
              ...integrated,
            }),
          ).toBe(`--include=*.zzz ${startup}`);
        }
        for (const file of files)
          expect(fs.readFileSync(path.join(own, file), "utf8")).toBe(content);
        expect(run(zsh ?? "", ["-c", "echo --include=*.zzz"], env)).toBe("");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!zsh)(
    "forwards the person's .zlogout only when an integrated login shell exits",
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-logout-"));
      const logout = path.join(home, "logout.txt");
      fs.writeFileSync(
        path.join(home, ".zlogout"),
        'printf "logout\\n" >> "$ZDOTDIR/logout.txt"\n',
      );
      const env = { PATH: process.env.PATH ?? "", HOME: home };
      try {
        const integrated = await codexShellEnvironment({ env, config: {} });
        expect(
          run(zsh ?? "", ["-i", "-c", "echo non-login"], {
            ...env,
            ...integrated,
          }),
        ).toBe("non-login");
        expect(fs.existsSync(logout)).toBe(false);
        expect(
          run(zsh ?? "", ["-l", "-i", "-c", "echo login"], {
            ...env,
            ...integrated,
          }),
        ).toBe("login");
        expect(fs.readFileSync(logout, "utf8")).toBe("logout\n");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!zsh).each([
    { transition: 'ZDOTDIR=""', expected: "unset" },
    { transition: "unset ZDOTDIR", expected: "home\nlogout-home" },
  ])(
    "preserves native startup and logout after .zshenv runs $transition",
    async ({ transition, expected }) => {
      const home = fs.mkdtempSync(
        path.join(os.tmpdir(), "codex-dotdir-change-"),
      );
      const own = path.join(home, "dotfiles");
      fs.mkdirSync(own);
      fs.writeFileSync(path.join(own, ".zshenv"), `${transition}\n`);
      fs.writeFileSync(
        path.join(home, ".zprofile"),
        "export ROOT_MARKER=home\n",
      );
      fs.writeFileSync(
        path.join(home, ".zlogout"),
        'printf "logout-home\\n"\n',
      );
      const env = { PATH: process.env.PATH ?? "", HOME: home, ZDOTDIR: own };
      const args = ["-l", "-i", "-c", `printf "%s\\n" "\${ROOT_MARKER-unset}"`];
      try {
        const native = run(zsh ?? "", args, env);
        expect(native).toBe(expected);
        const integrated = await codexShellEnvironment({ env, config: {} });
        expect(run(zsh ?? "", args, { ...env, ...integrated })).toBe(native);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  const roots: Array<{ policy: JsonObject; expected: string }> = [
    { policy: {}, expected: "/process-dotfiles" },
    {
      policy: { inherit: "all", set: { HOME: "/configured-home" } },
      expected: "/process-dotfiles",
    },
    {
      policy: { inherit: "core", set: { HOME: "/configured-home" } },
      expected: "/configured-home",
    },
    {
      policy: { inherit: "none", set: { HOME: "/configured-home" } },
      expected: "/configured-home",
    },
    { policy: { inherit: "core" }, expected: "/process-home" },
    { policy: { inherit: "none" }, expected: os.userInfo().homedir },
    {
      policy: {
        set: { ZDOTDIR: "/configured-dotfiles", HOME: "/configured-home" },
      },
      expected: "/configured-dotfiles",
    },
  ];
  it.each(roots)(
    "preserves the original dotfile root for $policy",
    async ({ policy, expected }) => {
      const result = await codexShellEnvironment({
        env: { HOME: "/process-home", ZDOTDIR: "/process-dotfiles" },
        config: { shell_environment_policy: policy },
      });
      expect(result?.USER_ZDOTDIR).toBe(expected);
    },
  );

  const filtered: JsonObject[] = [
    { exclude: ["ZDOTDIR"] },
    { include_only: ["PATH", "HOME"] },
    { filters: { ZDOTDIR: "exclude" } },
    { experimental_use_profile: true },
  ];
  it.each(filtered)(
    "leaves a custom Codex shell environment policy intact: %j",
    async (policy) => {
      expect(
        await codexShellEnvironment({
          env: {},
          config: { shell_environment_policy: policy },
        }),
      ).toBeNull();
    },
  );

  const emptyRoots: Array<{ env: NodeJS.ProcessEnv; policy: JsonObject }> = [
    { env: { ZDOTDIR: "" }, policy: {} },
    { env: {}, policy: { set: { ZDOTDIR: "" } } },
  ];
  it.each(emptyRoots)(
    "preserves an explicitly empty dotfile directory",
    async ({ env, policy }) => {
      expect(
        await codexShellEnvironment({
          env,
          config: { shell_environment_policy: policy },
        }),
      ).toBeNull();
    },
  );

  it.skipIf(!zsh)(
    "applies configured HOME inside zsh without moving the app-server home",
    async () => {
      const home = fs.mkdtempSync(
        path.join(os.tmpdir(), "codex-configured-home-"),
      );
      const env = {
        PATH: process.env.PATH ?? "",
        HOME: "/original-process-home",
      };
      try {
        fs.writeFileSync(
          path.join(home, ".zshenv"),
          'export OWN_HOME="$HOME"\n',
        );
        const integrated = await codexShellEnvironment({
          env,
          config: {
            shell_environment_policy: { inherit: "none", set: { HOME: home } },
          },
        });
        expect(integrated).not.toHaveProperty("HOME");
        expect({ ...env, ...integrated }.HOME).toBe("/original-process-home");
        expect(
          run(zsh ?? "", ["-c", 'printf "%s" "$OWN_HOME"'], {
            ...env,
            ...integrated,
          }),
        ).toBe(home);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
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
          // The person's own prompt hook keeps running beside Work's, its
          // trailing "; " (as history-sharing snippets leave it) included.
          // It rides the environment: a machine's own profile (a CI
          // runner's resets HOME) decides which ~/.bash_profile a login reads.
          PROMPT_COMMAND: 'printf "[own hook]"; ',
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
