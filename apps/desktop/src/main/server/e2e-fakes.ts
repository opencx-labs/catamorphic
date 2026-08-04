import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AgentEvent,
  CodingAgentProvider,
  CreateSandboxOpts,
  ExecOpts,
  ExecResult,
  GitCloneOpts,
  ProviderSession,
  SandboxHandle,
  SandboxProvider,
  SandboxStatus,
  StartSessionOpts,
} from "@catamorphic/sandbox";

const execFileAsync = promisify(execFile);

/**
 * E2E-only sandbox provider that runs on the host filesystem, one temp dir
 * per sandbox. Keeps agent-session plumbing (git baselines, file sync-back)
 * real while removing the microsandbox dependency from tests.
 */
export class E2eLocalSandboxProvider implements SandboxProvider {
  readonly workspaceRoot: string;
  private readonly roots = new Map<string, string>();
  private counter = 0;

  constructor() {
    this.workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "catamorphic-e2e-sbx-"),
    );
  }

  async createSandbox(_opts: CreateSandboxOpts): Promise<SandboxHandle> {
    this.counter += 1;
    const id = `e2e-sandbox-${this.counter}`;
    // All sandboxes share workspaceRoot (callers only ever use one dev
    // sandbox per project/user in these tests).
    this.roots.set(id, this.workspaceRoot);
    return { id, providerId: id, sandboxType: "dev", status: "started" };
  }

  async startSandbox(_sandboxId: string): Promise<void> {}
  async stopSandbox(_sandboxId: string): Promise<void> {}
  async destroySandbox(_sandboxId: string): Promise<void> {}

  async getSandboxStatus(_sandboxId: string): Promise<SandboxStatus> {
    return "started";
  }

  async executeCommand(
    _sandboxId: string,
    command: string,
    opts?: ExecOpts,
  ): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execFileAsync(
        "/bin/sh",
        ["-c", command],
        {
          cwd: opts?.cwd ?? this.workspaceRoot,
          env: { ...process.env, ...opts?.env },
          timeout: (opts?.timeout ?? 120) * 1000,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      return { exitCode: 0, result: `${stdout}${stderr}` };
    } catch (error) {
      const failure = error as {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      return {
        exitCode: typeof failure.code === "number" ? failure.code : 1,
        result: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
      };
    }
  }

  async uploadFiles(
    _sandboxId: string,
    files: Record<string, string>,
    basePath: string,
  ): Promise<void> {
    for (const [relativePath, content] of Object.entries(files)) {
      const filePath = path.join(basePath, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }
  }

  async downloadFile(_sandboxId: string, filePath: string): Promise<string> {
    return fs.readFileSync(filePath, "utf-8");
  }

  async gitClone(
    _sandboxId: string,
    _url: string,
    _path: string,
    _opts?: GitCloneOpts,
  ): Promise<void> {
    throw new Error("gitClone is not supported by the e2e sandbox provider");
  }

  async gitCheckout(
    _sandboxId: string,
    _path: string,
    _ref: string,
  ): Promise<void> {}
}

/**
 * E2E-only coding agent with scripted, prompt-keyed behavior:
 *
 * - "ask me ... questions" → a preamble, then an ask_user question turn;
 *   the follow-up answer gets acknowledged with plain text.
 * - "preamble" → two preamble text segments split by tool work, then a
 *   final summary (exercises the streamed-preamble message split).
 * - "edit a file" → writes a file in the sandbox (exercises changed-file
 *   sync-back and chips).
 * - "slowly" → a ~4s turn (exercises mid-turn UI: spinners, minimize,
 *   mode flips, kill-and-relaunch recovery).
 * - anything else → set_title + one text reply echoing the message.
 */
export class E2eFakeCodingAgent implements CodingAgentProvider {
  readonly name = "e2e-fake";
  private readonly sessions = new Map<
    string,
    { sandboxId: string; workingDirectory: string; askedQuestion: boolean }
  >();

  constructor(private readonly sandboxProvider: SandboxProvider) {}

  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    const providerSessionId = crypto.randomUUID();
    this.sessions.set(providerSessionId, {
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
      askedQuestion: false,
    });
    return {
      providerSessionId,
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
    };
  }

  async resumeSession(providerSessionId: string): Promise<ProviderSession> {
    const state = this.sessions.get(providerSessionId);
    return {
      providerSessionId,
      sandboxId: state?.sandboxId ?? "",
      workingDirectory: state?.workingDirectory ?? "",
    };
  }

  async *sendMessage(
    session: ProviderSession,
    message: string,
  ): AsyncIterable<AgentEvent> {
    const state = this.sessions.get(session.providerSessionId);
    if (!state) {
      yield { type: "error", content: "Session not found" };
      return;
    }
    const prompt = message.toLowerCase();

    if (state.askedQuestion) {
      state.askedQuestion = false;
      yield { type: "text", content: `Got it — noted: ${message}` };
      yield { type: "done" };
      return;
    }

    if (prompt.includes("ask me") && prompt.includes("question")) {
      state.askedQuestion = true;
      yield { type: "title", content: "Getting to know you" };
      yield {
        type: "text",
        content: "Happy to! A couple of quick questions first.",
      };
      yield {
        type: "question",
        questions: [
          {
            question: "What is your favorite color?",
            header: "Color",
            multiSelect: false,
            options: [
              { label: "Orange", description: "Warm and energetic." },
              { label: "Blue", description: "Calm and steady." },
            ],
          },
          {
            question: "Cats or dogs?",
            header: "Pets",
            multiSelect: false,
            options: [
              { label: "Cats", description: "Independent companions." },
              { label: "Dogs", description: "Loyal companions." },
            ],
          },
        ],
      };
      yield { type: "done" };
      return;
    }

    if (prompt.includes("preamble")) {
      yield { type: "title", content: "Preamble exercise" };
      yield { type: "text", content: "First, I will look at the project." };
      yield { type: "command", content: "ls" };
      yield { type: "text", content: "Found it. Now writing some notes." };
      yield { type: "file_edit", content: "write", filePath: "NOTES.md" };
      await this.sandboxProvider.uploadFiles(
        state.sandboxId,
        { "NOTES.md": "notes from the fake agent\n" },
        state.workingDirectory,
      );
      yield { type: "text", content: "All done: two preambles, one summary." };
      yield { type: "done" };
      return;
    }

    // "slowly" → a multi-second turn, so tests can exercise mid-turn UI
    // (spinners, minimize, mode flips) before the agent completes.
    if (prompt.includes("slowly")) {
      yield { type: "title", content: "Slow burn" };
      yield { type: "text", content: "Working on it, give me a moment." };
      yield { type: "command", content: "sleep" };
      await new Promise((resolve) => setTimeout(resolve, 4000));
      yield { type: "text", content: "Done after a long think." };
      yield { type: "done" };
      return;
    }

    if (prompt.includes("edit a file")) {
      yield { type: "title", content: "File edit exercise" };
      yield { type: "file_edit", content: "write", filePath: "HELLO.md" };
      await this.sandboxProvider.uploadFiles(
        state.sandboxId,
        { "HELLO.md": "hello from the fake agent\n" },
        state.workingDirectory,
      );
      yield { type: "text", content: "I created HELLO.md for you." };
      yield { type: "done" };
      return;
    }

    yield { type: "title", content: "Quick chat" };
    yield { type: "text", content: `You said: ${message}` };
    yield { type: "done" };
  }

  async dispose(session: ProviderSession): Promise<void> {
    this.sessions.delete(session.providerSessionId);
  }
}
