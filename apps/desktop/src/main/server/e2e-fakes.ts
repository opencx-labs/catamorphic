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
  ToolPermissionHandler,
  TurnOptions,
} from "@catamorphic/sandbox";
import { inlineAttachmentReferences } from "@catamorphic/sandbox";

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
 * - "subagent" → a delegated worker with nested activity (subagent chip).
 * - "watcher" → a background process event (watcher chip).
 * - "point: <target>" / "point keep: <target>" / "unpoint" → the real
 *   point_at / clear_pointers tools (glow + scroll).
 * - "show: <target>" → the real open_surface tool (tab behind the chat).
 * - "slowly" → a ~4s turn (exercises mid-turn UI: spinners, minimize,
 *   mode flips, kill-and-relaunch recovery).
 * - "auth error" → the turn fails with a provider-style credential
 *   rejection, verbatim OpenRouter 401 text (exercises the friendly
 *   auth-error rewrite in agent-errors.ts).
 * - anything else → set_title + one text reply echoing the message.
 */

/**
 * One-shot failure triggers, process-wide: a given trigger message fails
 * once and recovers on retry (same content re-runs); a NEW trigger message
 * fails again. Deliberately NOT per provider instance — a reconnect updates
 * the stored credential, which rebuilds the provider (agent-registry cache
 * key), exactly like production; the failure cause (the "expired key") must
 * not come back with the rebuilt instance.
 */
const oneShotFailures = new Set<string>();

export class E2eFakeCodingAgent implements CodingAgentProvider {
  readonly name = "e2e-fake";
  private readonly sessions = new Map<
    string,
    {
      sandboxId: string;
      workingDirectory: string;
      askedQuestion: boolean;
      interrupted: boolean;
      /**
       * The last turn this in-memory session ran, for retryTurn — the
       * same "history lives in memory" semantics as the ai-sdk harness,
       * so retry flows exercise the production paths (native re-run on a
       * live session; core's sendMessage fallback after a re-anchor).
       */
      lastTurn?: { message: string; opts?: TurnOptions };
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
    /**
     * The real tool-permission prompt (bridge → renderer consent modal),
     * so "permission: <server>/<tool>" exercises the ask path end to end
     * without a model or a live MCP server.
     */
    private readonly askToolPermission?: ToolPermissionHandler,
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
      interrupted: false,
      toolContext: {
        projectId: opts.projectId,
        sessionId: opts.sessionId,
        workingDirectory: opts.workingDirectory,
      },
    });
    return {
      providerSessionId,
      sessionId: opts.sessionId,
      projectId: opts.projectId,
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
    };
  }

  async *sendMessage(
    session: ProviderSession,
    message: string,
    opts?: TurnOptions,
  ): AsyncIterable<AgentEvent> {
    const state = session.providerSessionId
      ? this.sessions.get(session.providerSessionId)
      : undefined;
    if (!state) {
      yield { type: "error", content: "Session not found" };
      return;
    }
    state.workingDirectory = session.workingDirectory;
    state.toolContext.workingDirectory = session.workingDirectory;
    state.interrupted = false;
    state.lastTurn = { message, ...(opts ? { opts } : {}) };
    const prompt = message.toLowerCase();

    // Attachments echo what arrived (exercises the attachment path). Text
    // pills additionally echo their source and content so e2e can assert
    // the model-facing payload, not just the name.
    if (opts?.attachments && opts.attachments.length > 0) {
      const names = opts.attachments
        .map((attachment) => attachment.name)
        .join(", ");
      const texts = opts.attachments.filter(
        (attachment) => attachment.kind === "text",
      );
      yield {
        type: "title",
        content: texts.length > 0 ? "Context received" : "Media received",
      };
      // The prose as the model would read it: inline markers become
      // numbered references (the same rendering every real harness uses).
      yield {
        type: "text",
        content: `[prose] ${inlineAttachmentReferences(message, opts.attachments)}`,
      };
      yield {
        type: "text",
        content: `Received ${opts.attachments.length} attachment${
          opts.attachments.length > 1 ? "s" : ""
        }: ${names}`,
      };
      for (const attachment of texts) {
        if (attachment.kind !== "text") continue;
        yield {
          type: "text",
          content: `[text-pill ${attachment.source.type}${
            attachment.source.type === "selection"
              ? ` ${attachment.source.filePath}:${attachment.source.startLine ?? "?"}-${attachment.source.endLine ?? "?"}`
              : ""
          }] ${attachment.text}`,
        };
      }
      yield { type: "done" };
      return;
    }

    // "read the editor": overview → active editor tab → read_tab, echoing
    // the live selection the bridge exposes (agent-side selection path).
    if (prompt.includes("read the editor")) {
      const overviewTool = this.workspaceTools.find(
        (candidate) => candidate.name === "workspace_overview",
      );
      const readTool = this.workspaceTools.find(
        (candidate) => candidate.name === "read_tab",
      );
      if (!overviewTool || !readTool) {
        yield { type: "error", content: "workspace tools unavailable" };
        yield { type: "done" };
        return;
      }
      yield { type: "title", content: "Reading the editor" };
      const overview = (await overviewTool.execute({}, state.toolContext)) as {
        tabs?: Array<{ key: string; kind?: string; active?: boolean }>;
        activeTabKey?: string;
      };
      const tabs = overview.tabs ?? [];
      const editor =
        tabs.find(
          (tab) =>
            tab.kind === "editor" &&
            (tab.active || tab.key === overview.activeTabKey),
        ) ?? tabs.find((tab) => tab.kind === "editor");
      if (!editor) {
        yield { type: "text", content: "No editor tab is open." };
        yield { type: "done" };
        return;
      }
      const detail = (await readTool.execute(
        { key: editor.key },
        state.toolContext,
      )) as {
        filePath?: string;
        selection?: { text?: string; startLine?: number; endLine?: number };
      };
      yield {
        type: "text",
        content: detail.selection
          ? `[editor ${detail.filePath}:${detail.selection.startLine ?? "?"}-${detail.selection.endLine ?? "?"}] ${detail.selection.text ?? ""}`
          : `[editor ${detail.filePath}] no selection`,
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

    if (prompt.includes("clear todo list")) {
      const updateTodos = this.workspaceTools.find(
        (candidate) => candidate.name === "update_todo_list",
      );
      if (!updateTodos) {
        yield { type: "error", content: "todo tools unavailable" };
        yield { type: "done" };
        return;
      }
      const input = { items: [] };
      const result = await updateTodos.execute(input, state.toolContext);
      yield {
        type: "tool_call",
        toolName: "update_todo_list",
        toolInput: input,
        toolResult: result,
      };
      yield { type: "text", content: "I cleared the progress list." };
      yield { type: "done" };
      return;
    }

    if (prompt.includes("todo list")) {
      const updateTodos = this.workspaceTools.find(
        (candidate) => candidate.name === "update_todo_list",
      );
      if (!updateTodos) {
        yield { type: "error", content: "todo tools unavailable" };
        yield { type: "done" };
        return;
      }
      const input = {
        items: [
          {
            title: "Inspect the project",
            description:
              "Read the existing implementation and identify the right extension points.",
            status: "completed",
          },
          {
            title: "Verify the result",
            description:
              "Run the focused tests and confirm the user-facing behavior.",
            status: "in_progress",
          },
        ],
      };
      const result = await updateTodos.execute(input, state.toolContext);
      yield {
        type: "tool_call",
        toolName: "update_todo_list",
        toolInput: input,
        toolResult: result,
      };
      yield { type: "text", content: "I added a progress list to this chat." };
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

    // "subagent" → a delegated worker with nested activity (exercises the
    // subagent chip, its spinner while working, and the info popover).
    if (prompt.includes("subagent")) {
      yield { type: "title", content: "Delegating" };
      yield { type: "text", content: "I'll hand this to a reviewer." };
      yield {
        type: "subagent",
        status: "started",
        subagentId: "fake-task-1",
        subagentType: "code-reviewer",
        content: "Review the changes",
      };
      yield {
        type: "tool_call",
        toolName: "Grep",
        toolInput: { pattern: "TODO" },
        subagentId: "fake-task-1",
      };
      yield {
        type: "command",
        content: "bun test",
        subagentId: "fake-task-1",
      };
      await new Promise((resolve) => setTimeout(resolve, 800));
      yield { type: "subagent", status: "ended", subagentId: "fake-task-1" };
      yield { type: "text", content: "The reviewer found nothing alarming." };
      yield { type: "done" };
      return;
    }

    // "watcher" → a background process the agent started (exercises the
    // watcher chip that persists across turns).
    if (prompt.includes("watcher")) {
      yield { type: "title", content: "Background work" };
      yield { type: "text", content: "Starting the dev server for you." };
      yield {
        type: "background",
        status: "started",
        backgroundId: "fake-bg-1",
        content: "npm run dev",
      };
      yield { type: "text", content: "It's running in the background." };
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
      yield {
        type: "title",
        content: prompt.includes("private-marker")
          ? "Private marker"
          : "Slow burn",
      };
      yield { type: "text", content: "Working on it, give me a moment." };
      yield { type: "command", content: "sleep" };
      // Hidden Chromium renderers can throttle DOM updates heavily on loaded
      // CI runners. Keep the interruption fixture alive long enough for its
      // send-now control to render; ordinary slow-turn tests retain 4 seconds.
      const delayMs = prompt.includes("hold for coordination")
        ? 90_000
        : prompt.includes("wait for interruption")
          ? 30_000
          : 4000;
      const deadline = Date.now() + delayMs;
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

    if (prompt.includes("coordinate worktree")) {
      const listSessions = this.workspaceTools.find(
        (candidate) => candidate.name === "list_project_sessions",
      );
      const createWorktree = this.workspaceTools.find(
        (candidate) => candidate.name === "create_worktree",
      );
      if (!listSessions || !createWorktree) {
        yield { type: "error", content: "coordination tools unavailable" };
        yield { type: "done" };
        return;
      }
      const peers = await listSessions.execute({}, state.toolContext);
      const checkout = await createWorktree.execute({}, state.toolContext);
      if (
        checkout &&
        typeof checkout === "object" &&
        "path" in checkout &&
        typeof checkout.path === "string"
      ) {
        const filePath = path.join(checkout.path, "coordination-same-turn.txt");
        fs.writeFileSync(filePath, "created after checkout transition\n");
        yield { type: "file_edit", content: "write", filePath };
      }
      yield { type: "title", content: "Coordinating work" };
      yield {
        type: "text",
        content: `coordination result: ${JSON.stringify({ peers, checkout })}`,
      };
      yield { type: "done" };
      return;
    }

    if (prompt.includes("inspect coordination privacy")) {
      const listSessions = this.workspaceTools.find(
        (candidate) => candidate.name === "list_project_sessions",
      );
      const overview = this.workspaceTools.find(
        (candidate) => candidate.name === "workspace_overview",
      );
      if (!listSessions || !overview) {
        yield { type: "error", content: "coordination tools unavailable" };
        yield { type: "done" };
        return;
      }
      yield { type: "title", content: "Checking privacy" };
      yield {
        type: "text",
        content: `privacy result: ${JSON.stringify({
          peers: await listSessions.execute({}, state.toolContext),
          overview: await overview.execute({}, state.toolContext),
        })}`,
      };
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
          // biome-ignore lint/suspicious/noControlCharactersInRegex: strips OSC sequences from terminal output
          .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
          // biome-ignore lint/suspicious/noControlCharactersInRegex: strips CSI sequences
          .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "")
          // biome-ignore lint/suspicious/noControlCharactersInRegex: strips keypad mode toggles
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

    // "point: <target>" / "point keep: <target>" → the REAL point_at
    // workspace tool (glow + scroll); "unpoint" → clear_pointers.
    const pointRun = /^point(\s+keep)?:\s*(.+)$/s.exec(message.trim());
    if (pointRun) {
      const [, keep, target] = pointRun;
      const tool = this.workspaceTools.find(
        (candidate) => candidate.name === "point_at",
      );
      if (!tool || !target) {
        yield { type: "error", content: "point_at unavailable" };
        yield { type: "done" };
        return;
      }
      try {
        await tool.execute(
          {
            target: target.trim(),
            note: "Look here",
            ...(keep ? { keep_previous: true } : {}),
          },
          state.toolContext,
        );
        yield { type: "text", content: `Pointing at ${target.trim()}.` };
      } catch (error) {
        yield {
          type: "text",
          content: `point error: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      yield { type: "done" };
      return;
    }
    if (prompt.trim() === "unpoint") {
      const tool = this.workspaceTools.find(
        (candidate) => candidate.name === "clear_pointers",
      );
      if (tool) await tool.execute({}, state.toolContext);
      yield { type: "text", content: "Cleared the pointers." };
      yield { type: "done" };
      return;
    }

    // `Use the "<name>" skill` — the EXACT message palette skill rows and
    // composer /commands send — runs the REAL read_skill tool, so skill
    // e2e covers renderer → invocation message → toolkit → core's merged
    // tiers (project files + host skills) end to end.
    const skillRun = /^Use the "([^"]+)" skill[.:]?/.exec(message.trim());
    if (skillRun?.[1]) {
      const name = skillRun[1];
      const tool = this.workspaceTools.find(
        (candidate) => candidate.name === "read_skill",
      );
      if (!tool) {
        yield { type: "error", content: "read_skill unavailable" };
        yield { type: "done" };
        return;
      }
      yield { type: "title", content: "Skill exercise" };
      try {
        const result = (await tool.execute({ name }, state.toolContext)) as {
          source?: string;
          content?: string;
        };
        yield {
          type: "text",
          content: `skill loaded: ${name} (source:${result.source ?? "?"}, ${String(result.content ?? "").length} chars)`,
        };
      } catch (error) {
        yield {
          type: "text",
          content: `skill error: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      yield { type: "done" };
      return;
    }

    // "permission: <server>/<tool>" → the REAL tool-permission ask: the
    // front window shows the consent modal; the echo says what came back.
    const permissionRun = /^permission:\s*([^/\s]+)\/(\S+)$/.exec(
      message.trim(),
    );
    if (permissionRun?.[1] && permissionRun[2]) {
      if (!this.askToolPermission) {
        yield { type: "error", content: "tool permission prompt unavailable" };
        yield { type: "done" };
        return;
      }
      const decision = await this.askToolPermission({
        // The host session id, like real harnesses (ToolGate.decide) —
        // remote clients list pending asks per session over HTTP.
        ...(session.sessionId ? { sessionId: session.sessionId } : {}),
        server: permissionRun[1],
        tool: permissionRun[2],
        description: "E2E fake tool",
        input: { text: "hello from e2e" },
        annotations: { readOnlyHint: false },
      });
      yield {
        type: "text",
        content: `permission decision: ${decision.decision}${
          decision.decision === "allow" && decision.remember
            ? ` (${decision.remember})`
            : ""
        }`,
      };
      yield { type: "done" };
      return;
    }

    // "connect: <query>" → the REAL request_connection tool: the front
    // window opens the connectors modal seeded with the query; the tool
    // resolves with whatever the user (the test) installed before closing.
    const connectRun = /^connect:\s*(.+)$/s.exec(message.trim());
    if (connectRun?.[1]) {
      const tool = this.workspaceTools.find(
        (candidate) => candidate.name === "request_connection",
      );
      if (!tool) {
        yield { type: "error", content: "request_connection unavailable" };
        yield { type: "done" };
        return;
      }
      yield { type: "title", content: "Connection request" };
      try {
        const result = (await tool.execute(
          { query: connectRun[1].trim(), reason: "E2E exercise" },
          state.toolContext,
        )) as { installed?: string[] };
        yield {
          type: "text",
          content: `connection request settled: installed=[${(result.installed ?? []).join(", ")}]`,
        };
      } catch (error) {
        yield {
          type: "text",
          content: `connection error: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      yield { type: "done" };
      return;
    }

    // "show: <target>" → the REAL open_surface tool (focused open behind
    // the chat, or a background open + chip attention when the user is
    // elsewhere — the echoed "opened" field says which). "show later:"
    // delays the call ~2.5s so a test can move the user's focus away
    // first (the focus-steal regression pin).
    const showRun = /^show(\s+later)?:\s*(.+)$/s.exec(message.trim());
    if (showRun) {
      const [, later, rawTarget] = showRun;
      const target = rawTarget?.trim() ?? "";
      const tool = this.workspaceTools.find(
        (candidate) => candidate.name === "open_surface",
      );
      if (!tool) {
        yield { type: "error", content: "open_surface unavailable" };
        yield { type: "done" };
        return;
      }
      if (later) {
        const deadline = Date.now() + 2500;
        while (Date.now() < deadline && !state.interrupted) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      try {
        const result = (await tool.execute({ target }, state.toolContext)) as {
          key?: string;
          opened?: string;
        };
        yield {
          type: "text",
          content: `Opened ${target} ("key":"${result.key ?? "unknown"}", "opened":"${result.opened ?? "unknown"}").`,
        };
      } catch (error) {
        yield {
          type: "text",
          content: `open error: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      yield { type: "done" };
      return;
    }

    if (prompt.includes("auth error")) {
      if (!oneShotFailures.has(prompt)) {
        oneShotFailures.add(prompt);
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
      if (!oneShotFailures.has(prompt)) {
        oneShotFailures.add(prompt);
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

    if (prompt.includes("session menu")) {
      yield { type: "title", content: "Session menu" };
      yield { type: "text", content: "The session menu is ready." };
      yield { type: "done" };
      return;
    }

    yield { type: "title", content: "Quick chat" };
    yield { type: "text", content: `You said: ${message}` };
    yield { type: "done" };
  }

  /**
   * Native retry-in-place, mirroring the ai-sdk harness: the failed turn
   * re-runs from in-memory session state without a new user message. A
   * freshly re-anchored session (provider rebuilt after a reconnect)
   * holds no turn — core must route that retry through sendMessage
   * instead of ever reaching the defensive error below.
   */
  async *retryTurn(
    session: ProviderSession,
    opts?: TurnOptions & { sanitizeReasoning?: boolean },
  ): AsyncIterable<AgentEvent> {
    const state = session.providerSessionId
      ? this.sessions.get(session.providerSessionId)
      : undefined;
    if (!state) {
      yield {
        type: "error",
        content: "Session not found (host restarted?); start a new session",
      };
      return;
    }
    if (!state.lastTurn) {
      yield {
        type: "error",
        content:
          "This conversation was restored and the failed turn can't be " +
          "replayed automatically. Send your message again to continue.",
      };
      return;
    }
    const { message, opts: lastOpts } = state.lastTurn;
    yield* this.sendMessage(session, message, { ...lastOpts, ...opts });
  }

  async dispose(session: ProviderSession): Promise<void> {
    if (session.providerSessionId) {
      this.sessions.delete(session.providerSessionId);
    }
  }
}
