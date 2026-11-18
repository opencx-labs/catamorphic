import type {
  ExecOpts,
  SandboxFileOpts,
  SandboxProvider,
  SandboxSide,
} from "@catamorphic/sandbox";
import { describe, expect, it } from "vitest";
import {
  configureSandboxGateway,
  removeSandboxGateway,
  removeSessionCredentials,
} from "../services/sandbox-git.js";

/** Records what reaches each side of a sandbox (ADR 0332). */
function recordingProvider() {
  const uploads: Array<{ side: SandboxSide; files: string[]; base: string }> =
    [];
  const commands: Array<{ side: SandboxSide; command: string }> = [];
  const provider = {
    workspaceRoot: "/workspace",
    executeCommand: async (_id: string, command: string, opts?: ExecOpts) => {
      commands.push({ side: opts?.side ?? "commands", command });
      return { exitCode: 0, result: "" };
    },
    uploadFiles: async (
      _id: string,
      files: Record<string, string>,
      base: string,
      opts?: SandboxFileOpts,
    ) => {
      uploads.push({
        side: opts?.side ?? "commands",
        files: Object.keys(files).sort(),
        base,
      });
    },
  } as unknown as SandboxProvider;
  return { provider, uploads, commands };
}

const grants = [
  { alias: "github", grant: "github-grant", publicationRevision: "1" },
  { alias: "logs", grant: "logs-grant", publicationRevision: "1" },
  {
    alias: "model",
    grant: "model-grant",
    publicationRevision: "1",
    modelAttemptId: "attempt-1",
  },
];

describe("gateway grants on each side of a sandbox (ADR 0332)", () => {
  it("gives the agent only its model's grant and the commands only the bindings listed for them", async () => {
    const { provider, uploads, commands } = recordingProvider();
    await configureSandboxGateway({
      provider,
      sandboxId: "sandbox-1",
      gatewayGitUrl: "https://work.example/gateway/git",
      grants,
      gitAliases: [
        { alias: "github", remoteBaseUrls: ["https://github.com/"] },
      ],
      httpAliases: [
        { alias: "logs", url: "https://work.example/gateway/http/logs" },
      ],
      commands: { aliases: ["github"] },
    });
    const agent = uploads.filter((upload) => upload.side === "agent");
    const listed = uploads.filter((upload) => upload.side === "commands");
    // No grant is on both sides, and the agent has no Git or HTTP of its
    // own: its harness runs those where commands run.
    expect(agent.flatMap((upload) => upload.files)).toEqual([
      "model-grants/attempt-1/model/1",
      "read-grant",
    ]);
    // No model grant, nothing of `logs`, and no variables file for it.
    expect(listed.flatMap((upload) => upload.files)).toEqual([
      "git-credential-work",
      "gitconfig.in",
      "grants/github/1",
      "read-grant",
    ]);
    const commandScripts = commands
      .filter((command) => command.side === "commands")
      .map((command) => command.command)
      .join("\n");
    expect(commandScripts).not.toContain("model");
    expect(commandScripts).not.toContain("logs");
    expect(commandScripts).toContain("rm -f 'env/gateway.sh'");
  });

  it("rewrites the command side's Git configuration empty when nothing is listed", async () => {
    const { provider, uploads, commands } = recordingProvider();
    await configureSandboxGateway({
      provider,
      sandboxId: "sandbox-1",
      gatewayGitUrl: "https://work.example/gateway/git",
      grants,
      gitAliases: [
        { alias: "github", remoteBaseUrls: ["https://github.com/"] },
      ],
      commands: { aliases: [] },
    });
    expect(
      uploads
        .filter((upload) => upload.side === "commands")
        .flatMap((upload) => upload.files),
    ).toEqual(["read-grant"]);
    expect(
      commands.find(
        (command) =>
          command.side === "commands" && command.command.includes("gitconfig"),
      )?.command,
    ).toContain(": > ");
  });

  it("publishes once, on no side, when commands run beside the agent", async () => {
    const { provider, uploads } = recordingProvider();
    await configureSandboxGateway({
      provider,
      sandboxId: "sandbox-1",
      gatewayGitUrl: "https://work.example/gateway/git",
      grants,
      gitAliases: [],
    });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.side).toBe("commands");
    expect(uploads[0]?.files).toContain("grants/model/1");
  });

  it("takes grants out of both sides", async () => {
    const { provider, commands } = recordingProvider();
    await removeSessionCredentials({ provider, sandboxId: "sandbox-1" });
    await removeSandboxGateway({
      provider,
      sandboxId: "sandbox-1",
      projectDir: "/workspace/project",
    });
    expect(commands.map((command) => command.side)).toEqual([
      "commands",
      "agent",
      "commands",
      "agent",
    ]);
  });
});
