import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { InProcessRunner } from "@catamorphic/agent-runner";
import { expect, it } from "vitest";
import { createClaudeCodeAdapter } from "../index.js";
import {
  type ClaudeScenario,
  runScenario,
  scenarioAttempt,
  startScriptedModel,
} from "../testing/index.js";

/**
 * The pinned Claude Code CLI with its commands apart from it (ADR 0332):
 * its Bash runs through Work's shim, over the command socket, on a stand-in
 * for the command side whose temporary folder is not the CLI's. Output,
 * exit codes and the working directory come back; the checkout's own
 * settings never run beside the agent.
 */
it("runs the pinned CLI's commands through the command socket", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "claude-apart-")),
  );
  const directories = {
    here: {
      cwd: path.join(root, "work"),
      state: path.join(root, "state"),
      home: path.join(root, "home"),
    },
    elsewhere: {
      cwd: path.join(root, "work-elsewhere"),
      state: path.join(root, "state-elsewhere"),
      home: path.join(root, "home-elsewhere"),
    },
  };
  const hookMarker = path.join(root, "hook-ran");
  await mkdir(path.join(directories.here.cwd, ".claude"), { recursive: true });
  // A pull request's settings: a hook that would run beside the agent.
  await writeFile(
    path.join(directories.here.cwd, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: `touch '${hookMarker}'` }] },
        ],
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: `touch '${hookMarker}'` }],
          },
        ],
      },
    }),
  );
  const side = await commandSide({
    socket: path.join(root, "c.sock"),
    // The CLI's temporary folder, which the command side does not share.
    returnFolder: path.join(directories.here.state, "commands", "tmp"),
    elsewhere: path.join(root, "command-tmp"),
  });
  let cwd = directories.here.cwd;
  const scenario: ClaudeScenario = {
    name: "commands-apart",
    description: "Bash through the command socket.",
    model: (request) => {
      if (request.index === 0)
        return {
          blocks: [
            {
              type: "tool_use",
              id: "toolu_cd",
              name: "Bash",
              input: {
                command: "mkdir -p sub && cd sub && echo moved",
                description: "Move",
              },
            },
          ],
        };
      if (request.index === 1)
        return {
          blocks: [
            {
              type: "tool_use",
              id: "toolu_exit",
              name: "Bash",
              input: {
                command: "pwd; echo failing >&2; exit 3",
                description: "Fail",
              },
            },
          ],
        };
      return { blocks: [{ type: "text", text: "Done." }] };
    },
    attempts: [
      {
        start: (context) => {
          const start = scenarioAttempt({
            context,
            scenario: "commands-apart",
            turn: 1,
            text: "Move and fail",
          });
          return { ...start, commands: { socket: side.socket } };
        },
      },
    ],
    check: () => {},
  };
  const model = await startScriptedModel({
    reply: (request) => scenario.model(request, { cwd }),
  });
  try {
    await runScenario({
      scenario,
      directories,
      modelUrl: model.url,
      fixtureServer: { transport: "stdio", command: "unused" },
      onAttempt: (attempt) => {
        cwd = attempt.cwd;
      },
      runner: () =>
        new InProcessRunner({
          adapters: { "claude-code": createClaudeCodeAdapter() },
          version: "live",
        }),
      timeoutMs: 60_000,
    });
    const results = JSON.stringify(model.requests.at(-1)?.body.messages);
    // Every command crossed the socket, as bash.
    expect(
      side.requests.some((argv) => argv.join(" ").includes("echo moved")),
    ).toBe(true);
    expect(side.requests.every((argv) => argv[0] === "bash")).toBe(true);
    // Its output reached the agent, and so did the folder it moved to.
    expect(results).toContain("moved");
    expect(results).toContain(`${directories.here.cwd}/sub`);
    expect(results).toContain("failing");
    expect(results).toMatch(/exit code 3/i);
    // The checkout's hooks never ran.
    expect(fs.existsSync(hookMarker)).toBe(false);
  } finally {
    await model.close();
    await side.close();
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);

/**
 * A stand-in for the command side: runs each command here, but writes
 * what lands in the CLI's temporary folder to another folder, and returns
 * the files the shim asks for from there, as a separate container would.
 */
async function commandSide(input: {
  socket: string;
  returnFolder: string;
  elsewhere: string;
}): Promise<{ socket: string; requests: string[][]; close(): Promise<void> }> {
  await mkdir(input.elsewhere, { recursive: true });
  const requests: string[][] = [];
  const children = new Set<ChildProcess>();
  const server = net.createServer((socket) => {
    let pending = "";
    let child: ChildProcess | undefined;
    let returns: string[] = [];
    const send = (frame: object) => socket.write(`${JSON.stringify(frame)}\n`);
    socket.on("data", (data) => {
      pending += data.toString();
      for (
        let end = pending.indexOf("\n");
        end >= 0;
        end = pending.indexOf("\n")
      ) {
        const frame = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (!child) {
          requests.push(frame.argv);
          returns = frame.returns;
          const [file, ...args] = (frame.argv as string[]).map((arg) =>
            arg.replaceAll(`${input.returnFolder}/`, `${input.elsewhere}/`),
          );
          const started = spawn(file ?? "bash", args, {
            cwd: frame.cwd,
            env: frame.env,
            detached: true,
          });
          child = started;
          children.add(started);
          started.stdout?.on("data", (out: Buffer) =>
            send({ o: out.toString("base64") }),
          );
          started.stderr?.on("data", (out: Buffer) =>
            send({ e: out.toString("base64") }),
          );
          started.stdin?.on("error", () => {});
          started.once("close", async (code) => {
            children.delete(started);
            const files: Record<string, string> = {};
            for (const file of returns) {
              const moved = path.join(input.elsewhere, path.basename(file));
              const content = await readFile(moved).catch(() => undefined);
              if (content) files[file] = content.toString("base64");
            }
            if (Object.keys(files).length > 0) send({ r: files });
            send({ x: code ?? 137 });
            socket.end();
          });
        } else if (typeof frame.i === "string")
          child.stdin?.write(Buffer.from(frame.i, "base64"));
        else if (frame.eof) child.stdin?.end();
      }
    });
    socket.on("close", () => {
      if (child?.pid && child.exitCode === null)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
    });
  });
  await new Promise<void>((resolve) => server.listen(input.socket, resolve));
  return {
    socket: input.socket,
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const child of children)
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {}
        server.close(() => resolve());
      }),
  };
}
