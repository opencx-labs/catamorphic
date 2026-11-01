import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type CodexTransport,
  createCodexAdapter,
  processTransport,
  readCodexConfig,
  readCodexOptions,
} from "@catamorphic/codex";
import { pinnedCodexCommand } from "@catamorphic/codex/testing";
import { expect, it } from "vitest";
import {
  driveAttempt,
  NativeStore,
} from "../../../../packages/codex/src/__tests__/replay/driver.js";
import { modelServer } from "../../../../packages/codex/src/__tests__/replay/record-scenario.js";
import { attemptBase } from "../../../../packages/codex/src/__tests__/replay/scenarios.js";
import { codexShellEnvironment } from "./shell-integration.js";

const zsh = ["/bin/zsh", "/usr/bin/zsh"].find(existsSync);
// The exec_command snapshot engine uses the command's selected shell.
// Pin it to zsh instead of relying on the account's default shell.
const snapshotShell = zsh ?? "/bin/zsh";

async function nativeShellCase({
  snapshot,
  configured,
  timeout = false,
}: {
  snapshot: boolean;
  configured: string;
  timeout?: boolean;
}): Promise<void> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "codex-shell-")),
  );
  const own = path.join(root, "my dotfiles");
  const work = path.join(root, "work");
  const grants = path.join(root, "model-key");
  const home = path.join(root, "state", "codex-home");
  const processDots = path.join(root, "process dotfiles");
  const processHome = path.join(root, "process home");
  await Promise.all([
    mkdir(own),
    mkdir(work),
    mkdir(grants),
    mkdir(home, { recursive: true }),
    mkdir(processDots),
    mkdir(processHome),
  ]);
  await Promise.all([
    writeFile(path.join(grants, "1"), "fixture-model-key"),
    writeFile(path.join(work, "needle.ts"), "target marker\n"),
    writeFile(path.join(processDots, ".zshenv"), "export OWN_STARTUP=wrong\n"),
    writeFile(
      path.join(home, "config.toml"),
      `[shell_environment_policy.set]\n${configured} = ${JSON.stringify(own)}\n`,
    ),
    ...[".zshenv", ".zprofile", ".zshrc", ".zlogin"].map((file) =>
      writeFile(
        path.join(own, file),
        `export OWN_STARTUP=ran\nsetopt nomatch null_glob csh_null_glob\n${file === ".zshrc" ? 'work_snapshot_marker() { printf "snapshot=from-zshrc\\n"; }\n' : ""}`,
      ),
    ),
  ]);
  const problems: string[] = [];
  const command =
    'if (( $+functions[work_snapshot_marker] )); then work_snapshot_marker; else printf "snapshot=absent\\n"; fi; printf "%s\\n" --include=*.zzz "startup=$OWN_STARTUP"; printf "matched=%s\\n" *.ts; grep -r --include=*.ts target .';
  const markers = [
    "--include=*.zzz",
    "startup=ran",
    "matched=needle.ts",
    "./needle.ts:target marker",
  ];
  const model = await modelServer(
    timeout
      ? [
          {
            items: [{ message: "Waiting for the driver deadline." }],
            hang: true,
          },
        ]
      : [
          {
            items: [
              {
                call: "exec_command",
                args: {
                  cmd: command,
                  shell: snapshotShell,
                  login: true,
                },
              },
            ],
          },
          {
            expectInput: [
              ...markers,
              snapshot ? "snapshot=from-zshrc" : "snapshot=absent",
            ],
            rejectInput: ["no matches found"],
            items: [
              {
                call: "exec_command",
                args: { cmd: command, shell: zsh ?? "/bin/zsh", login: false },
              },
            ],
          },
          {
            expectInput: markers,
            rejectInput: ["no matches found"],
            items: [{ message: "Both commands reached grep." }],
          },
        ],
    problems,
  );
  let transport: CodexTransport | undefined;
  let processExited = false;
  let resolveExited = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  const adapter = createCodexAdapter({
    transport: (input) => {
      transport = processTransport({
        ...input,
        onExit: (exit) => {
          processExited = true;
          resolveExited();
          input.onExit(exit);
        },
      });
      return transport;
    },
  });
  try {
    const attempt = attemptBase(
      {
        root,
        model: model.url,
        node: process.execPath,
        fixtures: "unused",
        command: pinnedCodexCommand(),
      },
      { ordinal: 1, text: "Run both zsh searches." },
    );
    attempt.permissions = {
      sandbox: "danger-full-access",
      approvals: "never",
    };
    attempt.env = {
      HOME: processHome,
      ZDOTDIR: processDots,
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost",
    };
    const config = {
      ...readCodexOptions(attempt.options).config,
      "features.shell_snapshot": snapshot,
      // Unified exec consumes v2 snapshots; the legacy flag alone does not
      // exercise snapshots in exec_command on the pinned CLI.
      "features.shell_snapshot_v2": snapshot,
      "shell_environment_policy.inherit": "none",
      "shell_environment_policy.set.PATH": "/usr/bin:/bin",
    };
    attempt.options = { ...attempt.options, config };
    const environment = await codexShellEnvironment({
      env: { ...process.env, ...attempt.env },
      config: await readCodexConfig({ attempt }),
    });
    expect(environment?.USER_ZDOTDIR).toBe(own);
    expect(environment).not.toHaveProperty("HOME");
    attempt.env = { ...attempt.env, ...environment };
    // No explicit CODEX_HOME: gateway model access must keep its own
    // configuration in state/codex-home even with configured shell HOME.
    expect(attempt.env).not.toHaveProperty("CODEX_HOME");
    attempt.options = {
      ...attempt.options,
      config: {
        ...config,
        ...Object.fromEntries(
          Object.entries(environment ?? {}).map(([name, value]) => [
            `shell_environment_policy.set.${name}`,
            value,
          ]),
        ),
      },
    };
    expect(await readCodexConfig({ attempt })).toMatchObject({
      features: { shell_snapshot: snapshot, shell_snapshot_v2: snapshot },
      shell_environment_policy: {
        set: {
          ...(configured === "HOME" ? { HOME: own } : {}),
          ZDOTDIR: environment?.ZDOTDIR,
        },
      },
    });
    const result = await driveAttempt({
      adapter,
      attempt,
      store: new NativeStore(),
      timeoutMs: timeout ? 2_000 : 45_000,
    });
    expect(model.served()).toBe(3);
    expect(problems).toEqual([]);
    const commands = new Set(
      result.events.flatMap((event) =>
        event.type === "item.started" && event.item.kind === "command"
          ? [event.key]
          : [],
      ),
    );
    expect(
      result.events.filter(
        (event) => event.type === "item.completed" && commands.has(event.key),
      ),
    ).toMatchObject([
      { status: "completed", item: { exitCode: 0 } },
      { status: "completed", item: { exitCode: 0 } },
    ]);
    for (const event of result.events) {
      if (event.type !== "item.completed" || !commands.has(event.key)) continue;
      for (const marker of markers)
        expect(event.item).toMatchObject({
          output: expect.stringContaining(marker),
        });
    }
    const completed = result.events.filter(
      (event) => event.type === "item.completed" && commands.has(event.key),
    );
    expect(completed[0]).toMatchObject({
      item: {
        output: expect.stringContaining(
          snapshot ? "snapshot=from-zshrc" : "snapshot=absent",
        ),
      },
    });
    expect(completed[1]).toMatchObject({
      item: { output: expect.stringContaining("snapshot=absent") },
    });
    expect(
      result.events.find((event) => event.type === "turn.completed"),
    ).toMatchObject({
      status: "completed",
    });
  } finally {
    try {
      transport?.close();
      if (transport) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            exited,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(new Error("The native Codex process did not exit")),
                6_000,
              );
            }),
          ]);
          expect(processExited).toBe(true);
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      await model.close();
      if (!transport || processExited)
        await rm(root, { recursive: true, force: true });
    }
  }
}

it.skipIf(!zsh).each([
  { snapshot: true, configured: "ZDOTDIR" },
  { snapshot: false, configured: "ZDOTDIR" },
  { snapshot: true, configured: "HOME" },
  { snapshot: false, configured: "HOME" },
])(
  "the pinned Codex preserves configured $configured with shell_snapshot=$snapshot",
  nativeShellCase,
  60_000,
);

it.skipIf(!zsh)(
  "closes and joins the native shell fixture when its driver times out",
  async () => {
    await expect(
      nativeShellCase({ snapshot: false, configured: "HOME", timeout: true }),
    ).rejects.toThrow("did not finish");
  },
  20_000,
);

it.skipIf(!zsh || Boolean(process.env.CODEX_HOME))(
  "preserves host configuration with configured shell HOME and no explicit CODEX_HOME",
  async () => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "codex-host-home-")),
    );
    const processHome = path.join(root, "process-home");
    const own = path.join(root, "shell-home");
    const home = path.join(processHome, ".codex");
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(own),
      mkdir(path.join(root, "work")),
    ]);
    try {
      await writeFile(
        path.join(home, "config.toml"),
        `[shell_environment_policy.set]\nHOME = ${JSON.stringify(own)}\nLOCAL_CONFIG_MARKER = "original-process-home"\n`,
      );
      const attempt = attemptBase(
        {
          root,
          model: "unused",
          node: process.execPath,
          fixtures: "unused",
          command: pinnedCodexCommand(),
        },
        { ordinal: 1, text: "Read configuration only." },
      );
      attempt.modelAccess = { kind: "host" };
      attempt.env = { HOME: processHome };
      // The shared replay base configures the gateway's work provider. A
      // host-only configuration probe has no provider table to augment.
      attempt.options = {
        command: pinnedCodexCommand(),
        config: { "analytics.enabled": false, "feedback.enabled": false },
      };
      const config = await readCodexConfig({ attempt });
      expect(config).toMatchObject({
        shell_environment_policy: {
          set: { HOME: own, LOCAL_CONFIG_MARKER: "original-process-home" },
        },
      });
      const environment = await codexShellEnvironment({
        env: { ...process.env, ...attempt.env },
        config,
      });
      expect(environment).not.toHaveProperty("HOME");
      attempt.env = { ...attempt.env, ...environment };
      expect(attempt.env).not.toHaveProperty("CODEX_HOME");
      expect(attempt.env.HOME).toBe(processHome);
      expect(await readCodexConfig({ attempt })).toMatchObject({
        shell_environment_policy: {
          set: { HOME: own, LOCAL_CONFIG_MARKER: "original-process-home" },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
