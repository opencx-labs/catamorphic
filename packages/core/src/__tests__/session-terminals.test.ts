import type {
  ExecResult,
  ProcessOutput,
  SandboxProcess,
  SandboxProcessProvider,
  SandboxProvider,
} from "@catamorphic/sandbox";
import { describe, expect, it } from "vitest";
import { type Identity, PROJECT_PRINCIPAL_ID } from "../identity.js";
import { assertSessionWorkspaceAccess } from "../services/agent-session-access.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import {
  previewCommand,
  SessionPreviewError,
  SessionPreviewsService,
} from "../services/session-previews-service.js";
import {
  parseTerminalPty,
  prepareTerminalCommand,
  resizeTerminalCommand,
  sessionDirectoryFromProject,
  terminalProcessCommand,
  terminalSecretsSnippet,
} from "../services/session-terminal-scripts.js";
import type { SessionWorkspaceHandle } from "../services/session-workspace.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const tenantId = "22222222-2222-4222-8222-222222222222";
const PROJECT = PROJECT_PRINCIPAL_ID;

describe("who may work in a chat's workspace (ADR 0208)", () => {
  const member = (
    externalUserId: string,
    permissions: string[] = [],
  ): Identity => ({
    tenantId,
    externalUserId,
    scope: [{ kind: "agent", projectId, name: "*" }],
    projectPermissions: permissions.map((permission) => ({
      projectId,
      permission,
    })),
  });

  it("lets the owner in, and nobody else into a member's chat", () => {
    expect(() =>
      assertSessionWorkspaceAccess({
        identity: member("ada"),
        projectId,
        externalUserId: "ada",
        agentId: null,
      }),
    ).not.toThrow();
    // Reading or changing everyone's chats does not reach their workspaces.
    expect(() =>
      assertSessionWorkspaceAccess({
        identity: member("bob", ["sessions:write"]),
        projectId,
        externalUserId: "ada",
        agentId: null,
      }),
    ).toThrow(AccessDeniedError);
  });

  it("opens a project chat's workspace to sessions:write only", () => {
    expect(() =>
      assertSessionWorkspaceAccess({
        identity: member("bob", ["sessions:write"]),
        projectId,
        externalUserId: PROJECT,
        agentId: null,
      }),
    ).not.toThrow();
    for (const permissions of [[], ["sessions:read"]])
      expect(() =>
        assertSessionWorkspaceAccess({
          identity: member("bob", permissions),
          projectId,
          externalUserId: PROJECT,
          agentId: null,
        }),
      ).toThrow(AccessDeniedError);
  });

  it("refuses an owner whose role no longer reaches the chat's agent", () => {
    expect(() =>
      assertSessionWorkspaceAccess({
        identity: { tenantId, externalUserId: "ada", scope: [] },
        projectId,
        externalUserId: "ada",
        agentId: `project:${projectId}:reviewer`,
      }),
    ).toThrow(AccessDeniedError);
  });
});

describe("terminal shell commands", () => {
  const session = sessionDirectoryFromProject({
    projectDirectory: "/workspace/project",
    sessionDirectory: "/workspace/.work-session",
  });

  it("works from the project folder with paths relative to it", () => {
    expect(session).toBe("../.work-session");
    expect(
      prepareTerminalCommand({ sessionFromProject: session, key: "k" }),
    ).toContain("mkdir -p '../.work-session/terminals/k'");
  });

  it("loads the gateway's variables and the secrets, each only when it is there", () => {
    expect(terminalSecretsSnippet('"$s"')).toBe(
      'if [ -f "$s"/env/gateway.sh ]; then . "$s"/env/gateway.sh; fi; if [ -f "$s"/env/secrets.sh ]; then . "$s"/env/secrets.sh; fi',
    );
  });

  it("reads the pseudo-terminal the sandbox offers", () => {
    expect(parseTerminalPty("noise\npty=util-linux\n")).toBe("util-linux");
    expect(parseTerminalPty("pty=bsd")).toBe("bsd");
    expect(parseTerminalPty("pty=none")).toBe("none");
    expect(parseTerminalPty("")).toBe("none");
  });

  it("runs the shell under script, or plainly without it", () => {
    const linux = terminalProcessCommand({
      sessionFromProject: session,
      key: "k",
      pty: "util-linux",
    });
    expect(linux).toContain("script -qfec");
    expect(linux).toContain("/dev/null");
    expect(
      terminalProcessCommand({
        sessionFromProject: session,
        key: "k",
        pty: "bsd",
      }),
    ).toContain("script -q /dev/null /bin/sh");
    expect(
      terminalProcessCommand({
        sessionFromProject: session,
        key: "k",
        pty: "none",
      }),
    ).toContain('"$d" plain');
  });

  it("sizes the device with whole numbers only", () => {
    const command = resizeTerminalCommand({
      sessionFromProject: session,
      key: "k",
      cols: 120.7,
      rows: 40.2,
    });
    expect(command).toContain("stty cols 120 rows 40");
    expect(command).toContain("kill -WINCH");
  });
});

/** A workspace whose sandbox answers every command with `answer`. */
function workspace(answer: (command: string) => string): {
  handle: SessionWorkspaceHandle;
  commands: string[];
  uploads: Array<Record<string, string>>;
} {
  const commands: string[] = [];
  const uploads: Array<Record<string, string>> = [];
  const process: SandboxProcess = {
    processId: "proc-00000000",
    sandboxId: "sandbox",
    command: "",
    cwd: "/workspace/project",
    status: "running",
    exitCode: null,
    signal: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    outputBytes: 0,
  };
  const output: ProcessOutput = {
    processId: process.processId,
    chunk: "",
    cursor: 0,
    nextCursor: 0,
    more: false,
    outputBytes: 0,
    status: "running",
    exitCode: null,
    signal: null,
  };
  const processes: SandboxProcessProvider = {
    startProcess: async () => process,
    readProcessOutput: async () => output,
    signalProcess: async () => process,
    listProcesses: async () => [process],
    writeProcessInput: async () => {},
  };
  const provider: SandboxProvider = {
    workspaceRoot: "/workspace",
    processes,
    createSandbox: async () => {
      throw new Error("unused");
    },
    startSandbox: async () => {},
    stopSandbox: async () => {},
    destroySandbox: async () => {},
    getSandboxStatus: async () => "started",
    executeCommand: async (_id, command): Promise<ExecResult> => {
      commands.push(command);
      return { exitCode: 0, result: answer(command) };
    },
    uploadFiles: async (_id, files) => {
      uploads.push(files);
    },
    downloadFile: async () => "",
    gitClone: async () => {},
    gitCheckout: async () => {},
  };
  return {
    handle: {
      provider,
      sandboxId: "sandbox",
      projectDirectory: "/workspace/project",
      sessionDirectory: "/workspace/.work-session",
    },
    commands,
    uploads,
  };
}

describe("preview requests (ADR 0208)", () => {
  const identity: Identity = { tenantId, externalUserId: "ada" };
  const service = (handle: SessionWorkspaceHandle) =>
    new SessionPreviewsService({
      sessions: { personWorkspace: async () => handle },
    });

  it("withholds the caller's credential and answers what the script printed", async () => {
    const answer = {
      status: 404,
      headers: [
        ["set-cookie", "a=1"],
        ["set-cookie", "b=2"],
      ],
      bodyBase64: Buffer.from("missing").toString("base64"),
    };
    const sandbox = workspace(
      () => `login banner\nWORK-PREVIEW ${JSON.stringify(answer)}\nwarning\n`,
    );
    const response = await service(sandbox.handle).request({
      identity,
      projectId,
      sessionId: "session",
      port: 5173,
      method: "GET",
      path: "/missing",
      headers: [
        ["authorization", "Bearer secret-token"],
        ["cookie", "theme=dark"],
      ],
    });
    expect(response.status).toBe(404);
    expect(response.headers).toEqual([
      ["set-cookie", "a=1"],
      ["set-cookie", "b=2"],
    ]);
    expect(new TextDecoder().decode(response.body)).toBe("missing");
    const [command] = sandbox.commands;
    expect(command).not.toContain("secret-token");
    expect(command).toContain("theme=dark");
    expect(sandbox.uploads).toEqual([]);
  });

  it("uploads a large request instead of carrying it in the command", async () => {
    const sandbox = workspace(
      () => `WORK-PREVIEW ${JSON.stringify({ status: 204, headers: [] })}`,
    );
    await service(sandbox.handle).request({
      identity,
      projectId,
      sessionId: "session",
      port: 3000,
      method: "PUT",
      path: "/upload",
      headers: [],
      body: new Uint8Array(200_000),
    });
    expect(sandbox.uploads).toHaveLength(1);
    expect(Object.keys(sandbox.uploads[0] ?? {})[0]).toMatch(
      /^preview\/requests\/.+\.json$/,
    );
    expect(sandbox.commands[0]).not.toContain("WORK_PREVIEW_REQUEST");
  });

  it("says plainly when nothing listens, or the answer is unreadable", async () => {
    const refused = workspace(
      () =>
        `WORK-PREVIEW ${JSON.stringify({ error: "unreachable", message: "ECONNREFUSED" })}`,
    );
    await expect(
      service(refused.handle).request({
        identity,
        projectId,
        sessionId: "session",
        port: 3000,
        method: "GET",
        path: "/",
        headers: [],
      }),
    ).rejects.toMatchObject({
      constructor: SessionPreviewError,
      reason: "unreachable",
      message: "Nothing in this chat's workspace answers on port 3000.",
    });
    const garbled = workspace(() => "bash: node: command not found");
    await expect(
      service(garbled.handle).request({
        identity,
        projectId,
        sessionId: "session",
        port: 3000,
        method: "GET",
        path: "/",
        headers: [],
      }),
    ).rejects.toMatchObject({ reason: "failed" });
  });

  it("refuses ports, paths and methods outside HTTP's", async () => {
    const sandbox = workspace(() => "");
    for (const request of [
      { port: 0, path: "/", method: "GET" },
      { port: 65_536, path: "/", method: "GET" },
      { port: 80, path: "relative", method: "GET" },
      { port: 80, path: "/\r\nInjected: yes", method: "GET" },
      { port: 80, path: "/", method: "get it" },
    ])
      await expect(
        service(sandbox.handle).request({
          identity,
          projectId,
          sessionId: "session",
          headers: [],
          ...request,
        }),
      ).rejects.toMatchObject({ reason: "invalid" });
    expect(sandbox.commands).toEqual([]);
  });

  it("installs the script beside the request without ever half-writing it", () => {
    const command = previewCommand({
      sessionFromProject: "../.work-session",
      id: "request",
      description: "{}",
    });
    expect(command).toMatch(/cat > "\$f\.\$\$"/);
    expect(command).toContain('mv -f "$f.$$" "$f"');
    expect(command).toContain("unset HTTP_PROXY");
  });
});
