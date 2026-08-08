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
  ExtraTool,
  ExtraToolContext,
  GitCloneOpts,
  ProviderSession,
  SandboxHandle,
  SandboxProvider,
  SandboxStatus,
  StartSessionOpts,
  TurnOptions,
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
 * - "auth error" → the turn fails with a provider-style credential
 *   rejection, verbatim OpenRouter 401 text (exercises the friendly
 *   auth-error rewrite in agent-errors.ts).
 * - anything else → set_title + one text reply echoing the message.
 */
export class E2eFakeCodingAgent implements CodingAgentProvider {
  readonly name = "e2e-fake";
  private readonly sessions = new Map<
    string,
    {
      sandboxId: string;
      workingDirectory: string;
      askedQuestion: boolean;
      /**
       * Per-prompt one-shot failures: a given trigger message fails once
       * and recovers on retry (same content re-runs). A NEW trigger
       * message fails again — reconnect/retry flows need fresh failures.
       */
      failedPrompts: Set<string>;
      interrupted: boolean;
      /** Context for driving the real workspace toolkit ("terminal:"). */
      toolContext: ExtraToolContext;
    }
  >();

  constructor(
    private readonly sandboxProvider: SandboxProvider,
    /**
     * The real workspace toolkit, when the host has one: keyed prompts
     * ("terminal: <cmd>", "terminal @<id>: <cmd>") execute the actual
     * run_terminal tool, so e2e covers the bridge → renderer → chips
     * path with the deterministic agent.
     */
    private readonly workspaceTools: ExtraTool[] = [],
  ) {}

  interrupt(providerSessionId: string): void {
    const state = this.sessions.get(providerSessionId);
    if (state) state.interrupted = true;
  }

  /** In-memory like the real ai-sdk harness — resurrection tests rely
      on this reporting honestly after a relaunch. */
  hasSession(providerSessionId: string): boolean {
    return this.sessions.has(providerSessionId);
  }

  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    const providerSessionId = crypto.randomUUID();
    this.sessions.set(providerSessionId, {
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
      askedQuestion: false,
      failedPrompts: new Set(),
      interrupted: false,
      toolContext: { projectId: opts.projectId, sessionId: opts.sessionId },
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
    opts?: TurnOptions,
  ): AsyncIterable<AgentEvent> {
    const state = this.sessions.get(session.providerSessionId);
    if (!state) {
      yield { type: "error", content: "Session not found" };
      return;
    }
    state.interrupted = false;
    const prompt = message.toLowerCase();

    // Media messages echo what arrived (exercises the attachment path).
    if (opts?.attachments && opts.attachments.length > 0) {
      const names = opts.attachments
        .map((attachment) => attachment.name)
        .join(", ");
      yield { type: "title", content: "Media received" };
      yield {
        type: "text",
        content: `Received ${opts.attachments.length} attachment${
          opts.attachments.length > 1 ? "s" : ""
        }: ${names}`,
      };
      yield { type: "done" };
      return;
    }

    if (state.askedQuestion) {
      state.askedQuestion = false;
      yield { type: "text", content: `Got it, noted: ${message}` };
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
    // (spinners, minimize, mode flips, queueing, interrupts) before the
    // agent completes. Interruptible: the sleep polls the abort flag.
    if (prompt.includes("slowly")) {
      yield { type: "title", content: "Slow burn" };
      yield { type: "text", content: "Working on it, give me a moment." };
      yield { type: "command", content: "sleep" };
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !state.interrupted) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (state.interrupted) {
        yield { type: "error", content: "Interrupted." };
        yield { type: "done" };
        return;
      }
      yield { type: "text", content: "Done after a long think." };
      yield { type: "done" };
      return;
    }

    // "auth error" → the turn dies exactly the way a revoked key does in
    // production: the provider's raw 401 body as the error event. What the
    // user must see instead is the actionable rewrite (agent-errors.ts) —
    // the e2e asserts that mapping on the real send path. One-shot: the
    // retry of the same message recovers (exercises retry-in-place).
    // "terminal: <cmd>" / "terminal @<id>: <cmd>" → the REAL run_terminal
    // workspace tool. E2e's only path through the bridge with the
    // deterministic agent — chips, spinners, targeting all run for real.
    const terminalRun = /^terminal(?:\s+@(\S+))?:\s*(.+)$/s.exec(
      message.trim(),
    );
    if (terminalRun) {
      const [, targetId, command] = terminalRun;
      const tool = this.workspaceTools.find(
        (candidate) => candidate.name === "run_terminal",
      );
      if (!tool || !command) {
        yield { type: "error", content: "run_terminal unavailable" };
        yield { type: "done" };
        return;
      }
      yield { type: "title", content: "Terminal exercise" };
      yield { type: "command", content: command };
      try {
        const result = await tool.execute(
          { command, ...(targetId ? { terminalId: targetId } : {}) },
          state.toolContext,
        );
        // Human-readable body with the machine-readable bits e2e greps for
        // ('terminal result', the "terminalId":"..." pattern, and the raw
        // command output) preserved verbatim.
        const resultRecord = result as {
          terminalId?: string;
          output?: string;
          commandRunning?: boolean;
        };
        const cleanOutput = String(resultRecord.output ?? "")
          .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
          .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "")
          .replace(/\u001b[=>]/g, "")
          .trim();
        yield {
          type: "text",
          content: `Ran it in the terminal ("terminalId":"${resultRecord.terminalId ?? "unknown"}"). terminal result:\n\n${cleanOutput}`,
        };
      } catch (error) {
        yield {
          type: "text",
          content: `terminal error: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      yield { type: "done" };
      return;
    }

    if (prompt.includes("auth error")) {
      if (!state.failedPrompts.has(prompt)) {
        state.failedPrompts.add(prompt);
        yield { type: "error", content: "User not found." };
        yield { type: "done" };
        return;
      }
      yield { type: "text", content: "Recovered after reconnecting." };
      yield { type: "done" };
      return;
    }

    // "rate limit" → a provider-style 429, once per message; drives the
    // auto-retry backoff loop, whose retry then recovers.
    if (prompt.includes("rate limit")) {
      if (!state.failedPrompts.has(prompt)) {
        state.failedPrompts.add(prompt);
        yield { type: "error", content: "429 rate limit exceeded" };
        yield { type: "done" };
        return;
      }
      yield { type: "text", content: "Recovered after the rate limit." };
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
