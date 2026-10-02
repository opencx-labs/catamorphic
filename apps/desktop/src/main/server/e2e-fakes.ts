import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AgentAttachment,
  AgentQuestion,
  JsonValue,
  NativeRef,
  RuntimeRequestResponse,
} from "@catamorphic/agent-protocol";
import {
  type AttemptControl,
  type AttemptHost,
  type AttemptStart,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HostToolResult,
  RequestClosedError,
} from "@catamorphic/agent-protocol/runner";
import {
  appScaffold,
  projectDataDirectory,
  workspaceFiles,
} from "@catamorphic/core";
import type {
  CreateSandboxOpts,
  ExecOpts,
  ExecResult,
  GitCloneOpts,
  SandboxHandle,
  SandboxProvider,
  SandboxStatus,
} from "@catamorphic/sandbox";
import {
  inlineAttachmentReferences,
  StdioDeploymentRuntimeProvider,
} from "@catamorphic/sandbox";
import { z } from "zod";
import type { desktopSettingsContext } from "./desktop-settings-context.js";
import { reviewAppFiles, reviewAppSource } from "./e2e-review-app.js";
import { localAgentWorkspace } from "./local-agent-workspace.js";

const execFileAsync = promisify(execFile);

/**
 * E2E-only sandbox provider that runs on the host filesystem, one temp dir
 * per sandbox. Keeps agent-session plumbing (git baselines, file sync-back)
 * real while removing the microsandbox dependency from tests.
 */
export class E2eLocalSandboxProvider implements SandboxProvider {
  readonly workspaceRoot: string;
  readonly deploymentRuntime = new StdioDeploymentRuntimeProvider({
    uploadFiles: (sandboxId, files, basePath) =>
      this.uploadFiles(sandboxId, files, basePath),
    mkdirp: async (_sandboxId, directory) => {
      fs.mkdirSync(directory, { recursive: true });
    },
    openSupervisor: async ({ sandboxId, runtimeDirectory, env }) => {
      const child = spawn("bun", ["run", "entry.mjs"], {
        cwd: runtimeDirectory,
        env: {
          PATH: process.env.PATH,
          ...this.environments.get(sandboxId),
          ...env,
        },
        stdio: ["pipe", "pipe", "inherit"],
      });
      return {
        stdout: child.stdout,
        write: (data: string) =>
          new Promise<void>((resolve, reject) =>
            child.stdin.write(data, (error) =>
              error ? reject(error) : resolve(),
            ),
          ),
        kill: async () => {
          child.kill("SIGTERM");
        },
      };
    },
  });
  private readonly roots = new Map<string, string>();
  private readonly environments = new Map<string, Record<string, string>>();
  private readonly deploymentDirectories = new Map<string, string>();
  private counter = 0;

  constructor(
    private readonly projectDataDirectory?: (input: {
      projectId: string;
    }) => Promise<string | undefined>,
  ) {
    this.workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "catamorphic-e2e-sbx-"),
    );
  }

  async createSandbox(opts: CreateSandboxOpts): Promise<SandboxHandle> {
    this.counter += 1;
    const id = `e2e-sandbox-${this.counter}`;
    // All sandboxes share workspaceRoot (callers only ever use one dev
    // sandbox per project/user in these tests).
    this.roots.set(id, this.workspaceRoot);
    if (
      opts.labels?.purpose === "deployment-runtime" &&
      opts.labels.deploymentArtifactId
    ) {
      this.deploymentDirectories.set(
        id,
        path.join(
          this.workspaceRoot,
          "deployments",
          opts.labels.deploymentArtifactId,
        ),
      );
    }
    const data =
      opts.labels?.purpose === "deployment-runtime" && opts.labels.projectId
        ? await this.projectDataDirectory?.({
            projectId: opts.labels.projectId,
          })
        : undefined;
    this.environments.set(id, {
      ...opts.envVars,
      ...(data ? { WORK_APP_DATA_DIR: data } : {}),
    });
    return { id, providerId: id, sandboxType: "dev", status: "started" };
  }

  async startSandbox(_sandboxId: string): Promise<void> {}
  async stopSandbox(sandboxId: string): Promise<void> {
    await this.deploymentRuntime.releaseSandbox({ sandboxId });
  }
  async destroySandbox(sandboxId: string): Promise<void> {
    await this.deploymentRuntime.releaseSandbox({ sandboxId });
    const directory = this.deploymentDirectories.get(sandboxId);
    if (directory && fs.existsSync(directory)) {
      await execFileAsync("chmod", ["-R", "u+w", directory]);
      fs.rmSync(directory, { recursive: true, force: true });
    }
    this.deploymentDirectories.delete(sandboxId);
    this.environments.delete(sandboxId);
    this.roots.delete(sandboxId);
  }

  async getSandboxStatus(_sandboxId: string): Promise<SandboxStatus> {
    return "started";
  }

  async executeCommand(
    sandboxId: string,
    command: string,
    opts?: ExecOpts,
  ): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execFileAsync(
        "/bin/sh",
        ["-c", command],
        {
          cwd: opts?.cwd ?? this.workspaceRoot,
          env: {
            ...process.env,
            ...this.environments.get(sandboxId),
            ...opts?.env,
          },
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
 * One-shot failure triggers, process-wide: a given trigger message fails
 * once and recovers on retry (the same content runs again); a NEW trigger
 * message fails again.
 */
const oneShotFailures = new Set<string>();
const pdfArtifactSource =
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n5 0 obj\n<< /Length 51 >>\nstream\nBT /F1 18 Tf 30 100 Td (Linked PDF artifact) Tj ET\nendstream\nendobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000241 00000 n \n0000000311 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n411\n%%EOF\n";

const FAKE_CAPABILITIES: HarnessCapabilities = {
  steer: true,
  interrupt: true,
  // Core resends the input; the fake keeps no turn to run again.
  retry: false,
  fork: false,
  rollback: false,
  questions: true,
  approvals: true,
  elicitations: true,
  subagents: true,
  streamsText: true,
  streamsReasoning: false,
  nativeState: "store",
  ids: { thread: "strong", turn: "none", item: "none" },
};

/** One scripted step, the way the e2e scenarios are written. */
type FakeStep =
  | { type: "title"; content: string }
  | { type: "text"; content: string }
  /** Ends the turn failed, with the provider's own words. */
  | { type: "error"; content: string; retrySafe?: boolean }
  | {
      type: "tool_call";
      toolName?: string;
      toolInput?: unknown;
      toolResult?: unknown;
      /** Set to finish later with an `ended` step of the same id. */
      toolUseId?: string;
      status?: "ended";
      subagentId?: string;
      description?: string;
    }
  | {
      type: "command";
      content?: string;
      description?: string;
      toolUseId?: string;
      status?: "ended";
      toolResult?: string;
      subagentId?: string;
    }
  | { type: "file_edit"; content: "write" | "edit"; filePath: string }
  | {
      type: "subagent";
      status: "started" | "ended";
      subagentId: string;
      subagentType?: string;
      content?: string;
    }
  /** A question the person answers later, as their next message. */
  | { type: "question"; questions: AgentQuestion[] };

/** What a scripted turn can do: the real host tools, requests and files. */
interface FakeTurn {
  message: string;
  attachments: AgentAttachment[];
  projectId: string;
  sessionId: string;
  workingDirectory: string;
  /** The last turn asked the person a question this message answers. */
  askedQuestion: boolean;
  interrupted(): boolean;
  /** Waits, ending early when the turn is interrupted. */
  pause(ms: number): Promise<void>;
  /** A workspace tool, served as a host tool or a discovered capability. */
  tool(name: string, input: Record<string, unknown>): Promise<unknown>;
  /** A host tool's result as the harness receives it, images included. */
  toolResult(
    name: string,
    input: Record<string, unknown>,
  ): Promise<HostToolResult>;
  /** The next message the person sends into this turn. */
  nextSteer(): Promise<{ text: string; attachments: AgentAttachment[] }>;
  discover(query: string): Promise<{ items: Array<{ name: string }> }>;
  /** Discovers the capability by name, then invokes it. */
  capability(name: string, input: Record<string, unknown>): Promise<unknown>;
  writeFiles(files: Record<string, string>): Promise<void>;
  request(
    request: Parameters<AttemptHost["request"]>[1],
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeRequestResponse>;
  settingsContext(): ReturnType<typeof desktopSettingsContext> | undefined;
}

/**
 * E2E-only harness with scripted, prompt-keyed behavior over the real
 * host (ADR 0197): its tools are the desktop's workspace tools and
 * capabilities, its questions, approvals and elicitations are session
 * requests, and its files land in the chat's checkout. No model.
 *
 * - "ask me ... questions" → a preamble, then a question the next
 *   message answers ("Got it, noted").
 * - "blocking question" → a blocking question; a chat message sent while
 *   it waits is answered in the same turn and the question stays open
 *   (ADR 0195).
 * - "look at my screen" → read_tab's window screenshot.
 * - "close my questions" → the close_questions tool core gives every agent.
 * - "preamble" → two preamble segments split by tool work, then a summary.
 * - "edit a file" → writes a file (changed-file chips).
 * - "subagent" → a delegated worker with nested activity.
 * - "point: <target>" / "point keep: <target>" / "unpoint" → point_at.
 * - "show: <target>" → open_surface.
 * - "slowly" → a ~4s turn (mid-turn UI: spinners, queueing, interrupts).
 * - "narrate" / "step by step" → paced notes and commands.
 * - "auth error" / "rate limit" → a provider failure once per message.
 * - "permission: <server>/<tool>" → a tool approval request.
 * - "elicitation: queue|cancel|app" → MCP elicitation requests.
 * - anything else → a title and one reply echoing the message.
 */
export class E2eFakeAdapter implements HarnessAdapter {
  readonly id = "e2e-fake";

  constructor(
    private readonly options: {
      settingsContext?: (
        projectId: string,
      ) => ReturnType<typeof desktopSettingsContext>;
    } = {},
  ) {}

  capabilities(): HarnessCapabilities {
    return FAKE_CAPABILITIES;
  }

  start(attempt: AttemptStart, host: AttemptHost): AttemptControl {
    let interrupted = false;
    const wakers = new Set<() => void>();
    /** Messages sent into the turn that no step took, echoed at its end. */
    const steered: string[] = [];
    type Steer = { text: string; attachments: AgentAttachment[] };
    const steerWaiters: Array<(input: Steer) => void> = [];
    const pause = (ms: number) =>
      new Promise<void>((resolve) => {
        if (interrupted) return resolve();
        const wake = () => {
          clearTimeout(timer);
          wakers.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, ms);
        wakers.add(wake);
      });
    const run = async () => {
      const ref = threadRef(attempt);
      host.emit({ type: "thread", ref });
      const saved =
        attempt.thread.mode === "resume" || attempt.thread.mode === "restore"
          ? await host.nativeState.load({})
          : null;
      host.emit({ type: "turn.started" });
      const turn: FakeTurn = {
        message: attempt.input?.text ?? "",
        attachments: attempt.input?.attachments ?? [],
        projectId: attempt.projectId,
        sessionId: attempt.sessionId,
        workingDirectory: attempt.workingDirectory,
        askedQuestion: lastAskedQuestion(saved),
        interrupted: () => interrupted,
        pause,
        tool: (name, input) =>
          attempt.hostTools.some((tool) => tool.name === name)
            ? host.callTool({ name, input: toJson(input) }).then(toolValue)
            : turn.capability(`workspace.${name}`, input),
        toolResult: (name, input) =>
          host.callTool({ name, input: toJson(input) }),
        nextSteer: () =>
          new Promise<Steer>((resolve) => {
            steerWaiters.push(resolve);
          }),
        discover: async (query) =>
          z.object({ items: z.array(z.object({ name: z.string() })) }).parse(
            await host
              .callTool({
                name: "discover_capabilities",
                input: { query },
              })
              .then(toolValue),
          ),
        capability: async (name, input) => {
          const page = await turn.discover(name);
          if (!page.items.some((item) => item.name === name))
            throw new Error(`Capability unavailable: ${name}`);
          return host
            .callTool({
              name: "invoke_capability",
              input: { name, input: toJson(input), requestId: randomUUID() },
            })
            .then(toolValue);
        },
        writeFiles: (files) =>
          localAgentWorkspace.uploadFiles(
            "local",
            files,
            attempt.workingDirectory,
          ),
        request: (request, options) =>
          host.request(`request:${randomUUID()}`, request, options),
        settingsContext: () =>
          this.options.settingsContext?.(attempt.projectId),
      };
      const transcript = new FakeTranscript(host);
      let failure: { message: string; retrySafe?: boolean } | undefined;
      for await (const step of fakeScript(turn)) {
        if (step.type === "error") {
          failure = {
            message: step.content,
            ...(step.retrySafe ? { retrySafe: true } : {}),
          };
          break;
        }
        transcript.apply(step);
      }
      for (const text of steered)
        transcript.apply({ type: "text", content: `Steered: ${text}` });
      transcript.close();
      await host.nativeState.append({
        entries: [{ askedQuestion: turn.askedQuestion }],
      });
      if (interrupted)
        host.emit({ type: "turn.completed", status: "interrupted" });
      else if (failure)
        host.emit({ type: "turn.completed", status: "failed", error: failure });
      else host.emit({ type: "turn.completed", status: "completed" });
    };
    const finished = run().catch((error: unknown) => {
      host.emit({
        type: "turn.completed",
        status: interrupted ? "interrupted" : "failed",
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    });
    return {
      steer: async (input) => {
        const waiter = steerWaiters.shift();
        if (waiter) waiter(input);
        else steered.push(input.text);
        host.emit({ type: "input.consumed", itemIds: [input.itemId] });
        return true;
      },
      interrupt: () => {
        interrupted = true;
        for (const wake of [...wakers]) wake();
      },
      finished,
    };
  }
}

/** The native thread: Work's id when fresh, the stored one when resumed. */
function threadRef(attempt: AttemptStart): NativeRef {
  switch (attempt.thread.mode) {
    case "fresh":
      return { id: attempt.thread.providerThreadId, strength: "strong" };
    case "resume":
    case "restore":
      return attempt.thread.nativeRef;
    case "fork":
      return { id: randomUUID(), strength: "strong" };
  }
}

function lastAskedQuestion(saved: JsonValue[] | null): boolean {
  const last = saved?.at(-1);
  return Boolean(
    last &&
      typeof last === "object" &&
      !Array.isArray(last) &&
      last.askedQuestion === true,
  );
}

function toJson(value: unknown): JsonValue {
  const parsed: JsonValue = JSON.parse(JSON.stringify(value ?? null));
  return parsed;
}

/** A host tool's result as the value the tool returned. */
function toolValue(result: HostToolResult): unknown {
  const text = result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
  if (result.isError) throw new Error(text || "The tool failed");
  if (result.structured !== undefined) return result.structured;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Scripted steps as transcript items: text segments split by work. */
class FakeTranscript {
  private openText: string | undefined;
  private counter = 0;

  constructor(private readonly host: AttemptHost) {}

  apply(step: FakeStep): void {
    if (step.type === "text") {
      if (this.openText) {
        this.host.emit({
          type: "item.delta",
          key: this.openText,
          field: "text",
          text: `\n\n${step.content}`,
        });
        return;
      }
      this.openText = this.key("text");
      this.host.emit({
        type: "item.started",
        key: this.openText,
        item: { kind: "assistant_message", text: step.content, agentId: null },
      });
      return;
    }
    if (step.type === "title") {
      this.host.emit({ type: "title", text: step.content });
      return;
    }
    this.close();
    switch (step.type) {
      case "tool_call": {
        if (step.status === "ended" && step.toolUseId) {
          this.host.emit({
            type: "item.completed",
            key: step.toolUseId,
            status: "completed",
            ...(step.toolResult === undefined
              ? {}
              : { item: { result: toJson(step.toolResult) } }),
          });
          return;
        }
        const pending =
          Boolean(step.toolUseId) && step.toolResult === undefined;
        this.host.emit({
          type: "item.started",
          key: step.toolUseId ?? this.key("tool"),
          status: pending ? "in_progress" : "completed",
          item: {
            kind: "tool_call",
            tool: step.toolName ?? "tool",
            server: null,
            description: step.description || null,
            input: toJson(step.toolInput ?? {}),
            result:
              step.toolResult === undefined ? null : toJson(step.toolResult),
            error: null,
            ...(step.subagentId ? { parentKey: step.subagentId } : {}),
          },
        });
        return;
      }
      case "command": {
        if (step.status === "ended" && step.toolUseId) {
          this.host.emit({
            type: "item.completed",
            key: step.toolUseId,
            status: "completed",
            item: { output: step.toolResult ?? "", exitCode: 0 },
          });
          return;
        }
        this.host.emit({
          type: "item.started",
          key: step.toolUseId ?? this.key("command"),
          status: step.toolUseId ? "in_progress" : "completed",
          item: {
            kind: "command",
            command: step.content ?? "",
            description: step.description ?? null,
            output: "",
            exitCode: step.toolUseId ? null : 0,
            ...(step.subagentId ? { parentKey: step.subagentId } : {}),
          },
        });
        return;
      }
      case "file_edit":
        this.host.emit({
          type: "item.started",
          key: this.key("file"),
          status: "completed",
          item: {
            kind: "file_change",
            path: step.filePath,
            change: step.content === "write" ? "created" : "modified",
            previousPath: null,
          },
        });
        return;
      case "subagent":
        if (step.status === "ended") {
          this.host.emit({
            type: "item.completed",
            key: step.subagentId,
            status: "completed",
          });
          return;
        }
        this.host.emit({
          type: "item.started",
          key: step.subagentId,
          item: {
            kind: "subagent",
            title: step.content ?? "Subagent",
            agentType: step.subagentType ?? null,
            childSessionId: null,
            result: null,
          },
        });
        return;
      case "question":
        // The answer arrives as the person's next message.
        void this.host
          .request(this.key("question"), {
            kind: "question",
            blocking: false,
            title: "Question",
            origin: { kind: "tool", id: "ask_user", displayName: "Ask User" },
            questions: step.questions,
          })
          .catch(() => {});
        return;
    }
  }

  /** Ends the text segment being written, when there is one. */
  close(): void {
    if (!this.openText) return;
    this.host.emit({
      type: "item.completed",
      key: this.openText,
      status: "completed",
    });
    this.openText = undefined;
  }

  private key(prefix: string): string {
    this.counter += 1;
    return `${prefix}:${this.counter}`;
  }
}

/** The answer an approval or elicitation came back with, in the echo's words. */
function elicitationAction(
  response: RuntimeRequestResponse | undefined,
): string {
  return response?.kind === "elicitation" ? response.action : "decline";
}

async function* fakeScript(turn: FakeTurn): AsyncGenerator<FakeStep> {
  const message = turn.message;
  const prompt = message.toLowerCase();

  // A message the person sends while the question waits releases it (core
  // keeps it open beside the chat) and steers this turn (ADR 0195).
  if (prompt.includes("blocking question") && !prompt.includes("nonblocking")) {
    const reply = turn.nextSteer();
    try {
      const response = await turn.request({
        kind: "question",
        blocking: true,
        title: "Question",
        origin: { kind: "tool", id: "ask_user", displayName: "Ask User" },
        questions: [
          {
            question: "Which layout should I use?",
            header: "Layout",
            multiSelect: false,
            options: [
              { label: "Grid", description: "Cards in columns." },
              { label: "List", description: "One row per item." },
            ],
          },
        ],
      });
      yield {
        type: "text",
        content: `Using the ${response.kind === "question" ? response.answers.join(", ") : "default"} layout.`,
      };
    } catch (error) {
      if (!(error instanceof RequestClosedError)) throw error;
      const input = await Promise.race([
        reply,
        turn.pause(10_000).then(() => undefined),
      ]);
      if (input)
        yield {
          type: "text",
          content: `Replying before you answer: ${input.text}${
            input.attachments.length
              ? ` (attachments: ${input.attachments.map((item) => item.name).join(", ")})`
              : ""
          }`,
        };
    }
    return;
  }

  if (prompt.includes("look at my screen")) {
    const result = await turn.toolResult("read_tab", { key: "window" });
    const images = result.content.filter((part) => part.type === "image");
    const text = result.content.find((part) => part.type === "text");
    yield {
      type: "tool_call",
      toolName: "read_tab",
      toolInput: { key: "window" },
    };
    yield {
      type: "text",
      content: `Saw ${images.length} window image: ${text?.type === "text" ? text.text : "nothing"}`,
    };
    return;
  }

  if (prompt.includes("close my questions")) {
    const report = await turn.tool("close_questions", {});
    yield {
      type: "text",
      content: `Questions: ${typeof report === "string" ? report : JSON.stringify(report)}`,
    };
    return;
  }

  if (prompt.includes("nonblocking question")) {
    let answer: string[] | undefined;
    void turn
      .request({
        kind: "question",
        blocking: false,
        title: "Question",
        origin: { kind: "tool", id: "ask_user", displayName: "Ask User" },
        questions: [
          {
            question: "Which accent color should I use?",
            header: "Color",
            multiSelect: false,
            options: [
              { label: "Orange", description: "Warm and bright" },
              { label: "Blue", description: "Cool and calm" },
            ],
          },
        ],
      })
      .then(
        (response) => {
          if (response.kind === "question") answer = response.answers;
        },
        () => {},
      );
    // A non-blocking question's answer reaches the agent as a message
    // steered into the turn still working (ADR 0195).
    void turn.nextSteer().then((input) => {
      answer ??= [input.text.split("User answer:\n").pop() ?? input.text];
    });
    yield {
      type: "text",
      content: "I am continuing independent work while you decide.",
    };
    for (let step = 0; step < 100 && !turn.interrupted(); step++) {
      yield {
        type: "tool_call",
        toolName: "read",
        toolInput: { path: "notes.md" },
      };
      if (answer) {
        yield {
          type: "text",
          content: `Answer received during the same turn: ${answer.join("\n")}`,
        };
        return;
      }
      await turn.pause(200);
    }
    yield {
      type: "text",
      content: "Independent work finished; you can still answer later.",
    };
    return;
  }

  // Attachments echo what arrived (exercises the attachment path). Text
  // pills additionally echo their source and content so e2e can assert
  // the model-facing payload, not just the name.
  if (turn.attachments.length > 0) {
    const names = turn.attachments
      .map((attachment) => attachment.name)
      .join(", ");
    const texts = turn.attachments.filter(
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
      content: `[prose] ${inlineAttachmentReferences(message, turn.attachments)}`,
    };
    yield {
      type: "text",
      content: `Received ${turn.attachments.length} attachment${
        turn.attachments.length > 1 ? "s" : ""
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
    return;
  }

  if (prompt.startsWith("session workflow ")) {
    const sessionId = turn.sessionId;
    const scenario = prompt.slice("session workflow ".length).trim();
    if (
      scenario === "complete" ||
      scenario === "reopen" ||
      scenario === "notify" ||
      scenario === "spawn"
    ) {
      const result = await turn.capability(
        scenario === "notify"
          ? "project.send_agent_message"
          : `project.session_${scenario}`,
        {
          sessionId,
          idempotencyKey: `manual-${scenario}-${randomUUID()}`,
          ...(scenario === "complete"
            ? { content: "The requested work is finished." }
            : {}),
          ...(scenario === "notify"
            ? {
                toSessionId: sessionId,
                message: "This result needs your attention.",
                mode: "message_only",
                attention: "required",
              }
            : {}),
          ...(scenario === "spawn"
            ? {
                task: "Report that the delegated check is complete.",
                title: "Delegated check",
              }
            : {}),
        },
      );
      yield {
        type: "text",
        content: `Session ${scenario} recorded. ${JSON.stringify(result)}`,
      };
    } else {
      const name = `session${scenario.replace(/[^a-z]/g, "")}`;
      const source = sessionWorkflowFixture({ scenario, sessionId, name });
      const result = z.object({ id: z.string() }).parse(
        await turn.capability("project.create_watcher", {
          workflowName: name,
          source,
        }),
      );
      yield {
        type: "text",
        content: `Created [${scenario} workflow](artifact:${result.id}). It has no automatic expiry and stops after its intended result. Archiving this chat cancels it.`,
      };
    }
    return;
  }

  if (
    process.env.CATAMORPHIC_E2E_REVIEW === "1" &&
    prompt.includes("build an individual interactive code review")
  ) {
    const discovered = await turn.discover("components");
    if (!discovered.items.some((item) => item.name === "components.read"))
      throw new Error("Component registry was not discoverable");
    const listed = z
      .array(z.object({ name: z.string() }))
      .parse(await turn.capability("components.read", {}));
    if (!listed.some((item) => item.name === "code-review"))
      throw new Error("Review pack was not listed");
    const pack = await turn.capability("components.read", {
      name: "code-review",
    });
    yield {
      type: "tool_call",
      toolName: "invoke_capability",
      toolInput: { name: "components.read", input: { name: "code-review" } },
      toolResult: pack,
    };
    const input = {
      action: "create",
      kind: "app",
      name: "review",
      title: "Validate input before processing",
      source: reviewAppSource,
      files: reviewAppFiles(pack),
    };
    const artifacts = await turn.discover("session_artifact");
    if (
      !artifacts.items.some((item) => item.name === "project.session_artifact")
    )
      throw new Error("Session artifacts were not discoverable");
    const body = await turn.capability("project.session_artifact", {
      ...input,
      icon: "review",
    });
    const result = z
      .object({
        target: z.string(),
        build: z.object({ status: z.literal("ready") }),
      })
      .parse(body);
    yield {
      type: "tool_call",
      toolName: "invoke_capability",
      toolInput: { name: "project.session_artifact", input },
      toolResult: body,
    };
    yield { type: "text", content: `[Open review](${result.target})` };
    return;
  }

  // "read the editor": overview → active editor tab → read_tab, echoing
  // the live selection the bridge exposes (agent-side selection path).
  if (prompt.includes("read the editor")) {
    yield { type: "title", content: "Reading the editor" };
    const overview = z
      .object({
        tabs: z
          .array(
            z.object({
              key: z.string(),
              kind: z.string().optional(),
              active: z.boolean().optional(),
            }),
          )
          .optional(),
        activeTabKey: z.string().optional(),
      })
      .parse(await turn.tool("workspace_overview", {}));
    const tabs = overview.tabs ?? [];
    const editor =
      tabs.find(
        (tab) =>
          tab.kind === "editor" &&
          (tab.active || tab.key === overview.activeTabKey),
      ) ?? tabs.find((tab) => tab.kind === "editor");
    if (!editor) {
      yield { type: "text", content: "No editor tab is open." };
      return;
    }
    const detail = z
      .object({
        filePath: z.string().optional(),
        selection: z
          .object({
            text: z.string().optional(),
            startLine: z.number().optional(),
            endLine: z.number().optional(),
          })
          .optional(),
      })
      .parse(await turn.tool("read_tab", { key: editor.key }));
    yield {
      type: "text",
      content: detail.selection
        ? `[editor ${detail.filePath}:${detail.selection.startLine ?? "?"}-${detail.selection.endLine ?? "?"}] ${detail.selection.text ?? ""}`
        : `[editor ${detail.filePath}] no selection`,
    };
    return;
  }

  if (turn.askedQuestion) {
    turn.askedQuestion = false;
    yield { type: "text", content: `Got it, noted: ${message}` };
    return;
  }

  if (prompt.includes("clear todo list")) {
    const input = { items: [] };
    const result = await turn.tool("update_todo_list", input);
    yield {
      type: "tool_call",
      toolName: "update_todo_list",
      toolInput: input,
      toolResult: result,
    };
    yield { type: "text", content: "I cleared the progress list." };
    return;
  }

  if (prompt.includes("todo list")) {
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
    const result = await turn.tool("update_todo_list", input);
    yield {
      type: "tool_call",
      toolName: "update_todo_list",
      toolInput: input,
      toolResult: result,
    };
    yield { type: "text", content: "I added a progress list to this chat." };
    return;
  }

  if (prompt.includes("ask me") && prompt.includes("question")) {
    turn.askedQuestion = true;
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
    // Split the subagent's start and its later activity across preambles.
    yield { type: "text", content: "The reviewer is checking the details." };
    yield {
      type: "tool_call",
      toolName: "Grep",
      toolInput: { pattern: "TODO" },
      subagentId: "fake-task-1",
    };
    yield { type: "command", content: "bun test", subagentId: "fake-task-1" };
    await turn.pause(800);
    yield { type: "subagent", status: "ended", subagentId: "fake-task-1" };
    yield { type: "text", content: "The reviewer found nothing alarming." };
    return;
  }

  if (prompt.includes("prepare pdf")) {
    await turn.writeFiles({ "artifact.pdf": pdfArtifactSource });
    yield { type: "file_edit", content: "write", filePath: "artifact.pdf" };
    yield { type: "text", content: "PDF prepared." };
    return;
  }

  if (prompt.includes("build contained app")) {
    const result = await turn.tool("build_app", { name: "catalog" });
    yield { type: "text", content: `Catalog build: ${JSON.stringify(result)}` };
    return;
  }

  if (prompt.includes("contained workspace")) {
    await turn.writeFiles({
      ...workspaceFiles({ name: "contained-capabilities" }),
      ...appScaffold({ name: "catalog" }),
      ".work/apps/catalog/src/app.tsx":
        "export function App() { return <main><h1>Catalog</h1><p>The contained workspace is ready.</p></main>; }\n",
      ".work/workflows/src/catalog.ts": `import { defineWorkflow } from "@catamorphic/workflow";
import { mkdir, readFile, writeFile } from "node:fs/promises";
/** @displayname Save catalog
 * @param name - @displayname Catalog name
 */
async function saveCatalog({ name }: { name: string }) {
  "use step";
  const root = process.env.WORK_APP_DATA_DIR;
  if (!root) throw new Error("Persistent project data is unavailable");
  const directory = root + "/" + name;
  await mkdir(directory, { recursive: true });
  const file = directory + "/runs.txt";
  const runs = Number(await readFile(file, "utf8").catch(() => "0")) + 1;
  await writeFile(file, String(runs));
  return { ready: true, runs };
}
export const catalog = defineWorkflow(({ defineBoundary }) => ({
  steps: [defineBoundary({ run: async () => saveCatalog({ name: "catalog" }) })],
}));
`,
    });
    const data = projectDataDirectory({ root: turn.workingDirectory });
    fs.mkdirSync(path.join(data, "catalog"), { recursive: true });
    fs.writeFileSync(path.join(data, "catalog", "items.json"), "[]\n");
    yield {
      type: "text",
      content:
        "Created the workflow, app, and local data inside .work/. [Open catalog](catamorphic://workflow/catalog).",
    };
    return;
  }

  if (prompt.includes("artifact links")) {
    const files = {
      "artifact.pdf": pdfArtifactSource,
      "linked-notes.md":
        "# Linked notes\n\nAn artifact opened from an agent reply.\n",
      "linked-source.ts":
        "// Linked source\nexport const first = 1;\nexport const second = 2;\n",
      ".work/workflows/linked-workflow.ts":
        'import { defineWorkflow } from "@catamorphic/workflow";\n/** @displayname Make greeting\n * @param name - @displayname Name\n */\nasync function greet({ name }: { name: string }) { "use step"; return { greeting: "Hello " + name }; }\n/** @displayname Linked workflow */\nexport const linkedWorkflow = defineWorkflow(({ defineBoundary }) => ({ steps: [defineBoundary({ run: async () => greet({ name: "World" }) })] }));\n',
      ".work/apps/linked-app/package.json":
        '{"name":"linked-app","catamorphic":{"displayName":"Linked app"}}',
    };
    await turn.writeFiles(files);
    for (const filePath of Object.keys(files))
      yield { type: "file_edit", content: "write", filePath };
    yield {
      type: "text",
      content:
        "[Read linked notes](file:linked-notes.md) [Inspect linked source](file:linked-source.ts:3) [Open linked graph](workflow:linkedWorkflow) [Open linked app](app:linked-app) [Read linked PDF](file:artifact.pdf)",
    };
    return;
  }

  if (prompt.includes("preamble")) {
    yield { type: "title", content: "Preamble exercise" };
    yield { type: "text", content: "First, I will look at the project." };
    yield { type: "command", content: "ls" };
    yield { type: "text", content: "Found it. Now writing some notes." };
    yield { type: "file_edit", content: "write", filePath: "NOTES.md" };
    await turn.writeFiles({ "NOTES.md": "notes from the fake agent\n" });
    yield { type: "text", content: "All done: two preambles, one summary." };
    return;
  }

  if (prompt.includes("narrate")) {
    yield { type: "title", content: "Narrated fix" };
    yield { type: "text", content: "First, I will read the parser." };
    yield {
      type: "tool_call",
      toolName: "Read",
      toolInput: { file_path: "src/parser.ts" },
      toolUseId: "narrate-read",
    };
    await turn.pause(600);
    yield { type: "tool_call", toolUseId: "narrate-read", status: "ended" };
    yield { type: "text", content: "Found the bug. Fixing it, then testing." };
    yield { type: "file_edit", content: "edit", filePath: "src/parser.ts" };
    await turn.writeFiles({
      "src/parser.ts": "export const parse = (input = '') => input;\n",
    });
    yield {
      type: "command",
      content: "bun test",
      description: "Run the tests",
      toolUseId: "narrate-test",
    };
    await turn.pause(prompt.includes("stall") ? 45_000 : 3500);
    if (turn.interrupted()) return;
    yield {
      type: "command",
      toolUseId: "narrate-test",
      status: "ended",
      toolResult: "12 passed",
    };
    yield { type: "text", content: "Fixed: the parser handles empty input." };
    return;
  }

  // "step by step" → a paced turn of notes and commands, so the live
  // work can be watched (and filmed) as each step joins the list.
  if (prompt.includes("step by step")) {
    yield { type: "title", content: "Step by step" };
    // Each command carries its own words, as a harness's do: the live
    // line (and the running row's text) changes with every step.
    const segments = [
      {
        note: "Reading the parser and its tests first.",
        commands: [
          ["cat src/parser.ts", "Read the parser"],
          ["cat src/lexer.ts", "Read the lexer"],
          ["bun test src/parser.test.ts", "Run the parser tests"],
        ],
      },
      {
        note: "The lexer drops empty input. Checking every caller.",
        commands: [
          ["rg -n 'lex\\(' src", "Find the lexer's callers"],
          ["cat src/cli.ts", "Read the CLI entry"],
          ["bun test", "Run every test"],
        ],
      },
    ];
    for (const [index, segment] of segments.entries()) {
      if (turn.interrupted()) break;
      yield { type: "text", content: segment.note };
      for (const [step, [command, description]] of segment.commands.entries()) {
        const toolUseId = `step-${index}-${step}`;
        yield { type: "command", content: command, description, toolUseId };
        await turn.pause(900);
        yield { type: "command", toolUseId, status: "ended", toolResult: "ok" };
        if (turn.interrupted()) break;
      }
    }
    if (turn.interrupted()) return;
    yield { type: "text", content: "Fixed: empty input parses to nothing." };
    return;
  }

  // "slowly" → a multi-second turn, so tests can exercise mid-turn UI
  // (spinners, minimize, mode flips, queueing, interrupts) before the
  // agent completes. Interruptible.
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
    await turn.pause(
      prompt.includes("hold for coordination")
        ? 90_000
        : prompt.includes("wait for interruption")
          ? 30_000
          : 4000,
    );
    if (turn.interrupted()) return;
    yield { type: "text", content: "Done after a long think." };
    return;
  }

  if (prompt.includes("coordinate worktree")) {
    const peers = await turn.tool("list_project_sessions", {});
    const checkout = await turn.tool("create_worktree", {});
    const created = z.object({ path: z.string() }).safeParse(checkout);
    if (created.success) {
      const filePath = path.join(
        created.data.path,
        "coordination-same-turn.txt",
      );
      fs.writeFileSync(filePath, "created after checkout transition\n");
      yield { type: "file_edit", content: "write", filePath };
    }
    yield { type: "title", content: "Coordinating work" };
    yield {
      type: "text",
      content: `coordination result: ${JSON.stringify({ peers, checkout })}`,
    };
    return;
  }

  if (prompt.includes("inspect coordination privacy")) {
    yield { type: "title", content: "Checking privacy" };
    yield {
      type: "text",
      content: `privacy result: ${JSON.stringify({
        peers: await turn.tool("list_project_sessions", {}),
        overview: await turn.tool("workspace_overview", {}),
      })}`,
    };
    return;
  }

  // "terminal: <cmd>" → the REAL run_background_command tool, then a
  // blocking read until it ends: e2e's path through the bridge with the
  // deterministic agent (chips, spinners, output). "background: <cmd>"
  // starts one and ends the turn, leaving it to wake the chat.
  const terminalRun = /^(terminal|background):\s*(.+)$/s.exec(message.trim());
  if (terminalRun?.[2]) {
    const [, mode, command] = terminalRun;
    // Without words of its own, a command is titled by itself.
    const description = mode === "background" ? "Run it in the background" : "";
    yield { type: "title", content: "Terminal exercise" };
    yield {
      type: "tool_call",
      toolName: "run_background_command",
      toolInput: { command, description },
      description,
    };
    try {
      const started = z
        .object({
          id: z.string(),
          key: z.string(),
          status: z.string(),
          output: z.string(),
        })
        .parse(
          await turn.tool("run_background_command", {
            command,
            description,
            wake_on_exit: mode === "background",
          }),
        );
      if (mode === "background") {
        yield {
          type: "text",
          content: `Started it in the background ("terminalId":"${started.id}").`,
        };
        return;
      }
      let output = started.output;
      if (started.status === "running") {
        const finished = z.object({ output: z.string() }).parse(
          await turn.tool("read_background_output", {
            id: started.id,
            wait_seconds: 60,
          }),
        );
        output += finished.output;
      }
      yield {
        type: "text",
        content: `Ran it in the terminal ("terminalId":"${started.id}"). terminal result:\n\n${cleanTerminalText(output)}\n\n[Open terminal](${started.key})`,
      };
    } catch (error) {
      yield {
        type: "text",
        content: `terminal error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return;
  }

  // Native app consent: the first answer may allow the app for the rest
  // of this turn, so the second identical request needs no answer.
  if (message === "elicitation: app") {
    const ask = () =>
      turn.request({
        kind: "elicitation",
        blocking: true,
        title: "Computer Use",
        origin: {
          kind: "mcp",
          id: "computer-use",
          displayName: "Computer Use",
        },
        elicitation: {
          server: "Computer Use",
          message: 'Allow Computer Use to use "Calculator"?',
          schema: { type: "object", properties: {} },
        },
      });
    const first = elicitationAction(await ask().catch(() => undefined));
    const second =
      first === "accept"
        ? "accept"
        : elicitationAction(await ask().catch(() => undefined));
    yield { type: "text", content: `app consent: ${first},${second}` };
    return;
  }

  if (message === "elicitation: queue" || message === "elicitation: cancel") {
    const abort = new AbortController();
    const timer =
      message === "elicitation: cancel"
        ? setTimeout(() => abort.abort(), 1200)
        : undefined;
    try {
      const results = await Promise.all(
        (message === "elicitation: queue"
          ? ["First app", "Second app"]
          : ["Cancelled app"]
        ).map((label) =>
          turn
            .request(
              {
                kind: "elicitation",
                blocking: true,
                title: label,
                origin: { kind: "mcp", id: label, displayName: label },
                elicitation: {
                  server: label,
                  message: `Allow access to ${label}?`,
                  schema: { type: "object", properties: {} },
                },
              },
              { signal: abort.signal },
            )
            .then(elicitationAction, (error: unknown) => {
              if (error instanceof RequestClosedError) return "decline";
              throw error;
            }),
        ),
      );
      yield {
        type: "text",
        content: `elicitation decisions: ${results.join(",")}`,
      };
    } finally {
      clearTimeout(timer);
    }
    return;
  }

  if (message.startsWith("E2E workspace tool ")) {
    const request = z
      .object({
        name: z.string(),
        input: z.record(z.string(), z.unknown()),
        serial: z.union([z.string(), z.number()]),
      })
      .parse(JSON.parse(message.slice("E2E workspace tool ".length)));
    let body: string;
    try {
      // A page image is the result's content itself; anything else reads
      // as the tool's value.
      const result =
        request.name === "browser_snapshot" && request.input.format === "image"
          ? {
              content: (
                await turn.toolResult("invoke_capability", {
                  name: "workspace.browser_snapshot",
                  input: request.input,
                  requestId: randomUUID(),
                })
              ).content,
            }
          : await turn.tool(request.name, request.input);
      body = JSON.stringify(result, (key, value) =>
        key === "data" && typeof value === "string" && value.length > 1000
          ? `<${value.length} base64 characters>`
          : value,
      );
    } catch (error) {
      body = JSON.stringify({ error: String(error) });
    }
    yield {
      type: "text",
      content: `\n\`\`\`json\nE2E result ${request.serial}: ${body}E2E end\n\`\`\``,
    };
    return;
  }

  // "point: <target>" / "point keep: <target>" → the REAL point_at
  // workspace tool (glow + scroll); "unpoint" → point_at { target: null }.
  const pointRun = /^point(\s+keep)?:\s*(.+)$/s.exec(message.trim());
  if (pointRun?.[2]) {
    const [, keep, target] = pointRun;
    try {
      await turn.tool("point_at", {
        target: target.trim(),
        note: "Look here",
        ...(keep ? { keep_previous: true } : {}),
      });
      yield { type: "text", content: `Pointing at ${target.trim()}.` };
    } catch (error) {
      yield {
        type: "text",
        content: `point error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return;
  }
  if (prompt.trim() === "unpoint") {
    await turn.tool("point_at", { target: null });
    yield { type: "text", content: "Cleared the pointers." };
    return;
  }

  if (message.trim() === "E2E enable personal framed content") {
    const context = turn.settingsContext();
    const file = context?.files?.preferences.personal;
    if (!file || context.access !== "native")
      throw new Error("Personal settings file unavailable");
    const raw = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : {};
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...raw, contentFrame: true }));
    yield {
      type: "text",
      content: "Personal framed content updated by editing its JSON file.",
    };
    return;
  }

  // Native Codex discovery supplies a concrete file, outside the shared
  // read_skill catalog. Exercise the actual file read and argument payload.
  const nativeSkillRun =
    /^Use the "native-notes" skill at ("(?:[^"\\]|\\.)*")\.\s*([\s\S]*)$/.exec(
      message.trim(),
    );
  if (nativeSkillRun?.[1]) {
    const file: unknown = JSON.parse(nativeSkillRun[1]);
    if (typeof file !== "string") throw new Error("Invalid native skill path");
    yield {
      type: "text",
      content: `native skill loaded: ${fs.readFileSync(file, "utf8").trim()} | ${nativeSkillRun[2]}`,
    };
    return;
  }

  // `Use the "<name>" skill`, the EXACT message palette skill rows and
  // composer /commands send, runs the REAL read_skill tool, so skill e2e
  // covers renderer → invocation message → toolkit → core's merged tiers.
  const skillRun = /^Use the "([^"]+)" skill[.:]?/.exec(message.trim());
  if (skillRun?.[1]) {
    const name = skillRun[1];
    yield { type: "title", content: "Skill exercise" };
    try {
      const result = z
        .object({
          source: z.string().optional(),
          content: z.string().optional(),
        })
        .parse(await turn.tool("read_skill", { name }));
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
    return;
  }

  // "permission: <server>/<tool>" → a tool approval request, answered
  // from the chat (or any client); the echo says what came back.
  const permissionRun = /^permission:\s*([^/\s]+)\/(\S+)$/.exec(message.trim());
  if (permissionRun?.[1] && permissionRun[2]) {
    const [, server, tool] = permissionRun;
    const response = await turn
      .request({
        kind: "approval",
        blocking: true,
        title: `Allow ${tool}?`,
        origin: { kind: "mcp", id: server, displayName: server },
        approval: {
          action: `${server} · ${tool}`,
          details: "E2E fake tool",
          tool: { server, name: tool, input: { text: "hello from e2e" } },
        },
      })
      .catch(() => undefined);
    const allowed =
      response?.kind === "approval" && response.decision === "approved";
    yield {
      type: "text",
      content: `permission decision: ${allowed ? "allow" : "deny"}${
        allowed && response.remember ? ` (${response.remember})` : ""
      }`,
    };
    return;
  }

  // "connect: <query>" → the REAL request_connection tool: the front
  // window opens the connectors modal seeded with the query; the tool
  // resolves with whatever the user (the test) installed before closing.
  const connectRun = /^connect:\s*(.+)$/s.exec(message.trim());
  if (connectRun?.[1]) {
    yield { type: "title", content: "Connection request" };
    try {
      const result = z
        .object({ installed: z.array(z.string()).optional() })
        .parse(
          await turn.tool("request_connection", {
            query: connectRun[1].trim(),
            reason: "E2E exercise",
          }),
        );
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
    return;
  }

  // "show: <target>" → the REAL open_surface tool (focused open behind the
  // chat, or a background open + chip attention when the user is
  // elsewhere; the echoed "opened" field says which). "show later:" delays
  // the call ~2.5s so a test can move the user's focus away first.
  const showRun = /^show(\s+later)?:\s*(.+)$/s.exec(message.trim());
  if (showRun) {
    const [, later, rawTarget] = showRun;
    const target = rawTarget?.trim() ?? "";
    if (later) await turn.pause(2500);
    try {
      const result = z
        .object({ key: z.string().optional(), opened: z.string().optional() })
        .parse(await turn.tool("open_surface", { target }));
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
    return;
  }

  // "auth error" → the turn dies the way a revoked key does: the
  // provider's raw 401 body. The person sees the actionable rewrite
  // (agent-errors.ts). One-shot: the retry of the same message recovers.
  if (prompt.includes("auth error")) {
    if (!oneShotFailures.has(prompt)) {
      oneShotFailures.add(prompt);
      yield { type: "error", content: "User not found." };
      return;
    }
    yield { type: "text", content: "Recovered after reconnecting." };
    return;
  }

  // "rate limit" → a provider-style 429, once per message; drives the
  // auto-retry backoff loop, whose retry then recovers.
  if (prompt.includes("rate limit")) {
    if (!oneShotFailures.has(prompt)) {
      oneShotFailures.add(prompt);
      yield {
        type: "error",
        content: "429 rate limit exceeded",
        retrySafe: true,
      };
      return;
    }
    yield { type: "text", content: "Recovered after the rate limit." };
    return;
  }

  if (prompt.includes("desktop layout: sidebar")) {
    await turn.writeFiles({
      ".work/desktop/layout.json": JSON.stringify({
        tabPlacement: "sidebar",
        pinnedBookmarks: "list",
        headerPlacement: "sidebar",
      }),
    });
    yield { type: "text", content: "Updated your workspace layout." };
    return;
  }

  if (prompt.includes("edit a file")) {
    yield { type: "title", content: "File edit exercise" };
    yield { type: "file_edit", content: "write", filePath: "HELLO.md" };
    await turn.writeFiles({ "HELLO.md": "hello from the fake agent\n" });
    yield { type: "text", content: "I created HELLO.md for you." };
    return;
  }

  if (prompt.includes("session menu")) {
    yield { type: "title", content: "Session menu" };
    yield { type: "text", content: "The session menu is ready." };
    return;
  }

  yield { type: "title", content: "Quick chat" };
  yield { type: "text", content: `You said: ${message}` };
}
/** Credential-free scenarios still author ordinary source and execute real host transitions. */
function sessionWorkflowFixture({
  scenario,
  sessionId,
  name,
}: {
  scenario: string;
  sessionId: string;
  name: string;
}): string {
  const triggerConfig =
    scenario === "monitor"
      ? `trigger("session.work-changed", { sessionId: ${JSON.stringify(sessionId)}, workStatus: "completed" })`
      : `trigger("schedule", { at: ${JSON.stringify(new Date(Date.now() + (scenario === "longreminder" ? 7 * 86_400_000 : scenario === "overdue" ? -7 * 86_400_000 : 10_000)).toISOString())} })`;
  const action =
    scenario === "quiet"
      ? "return { changed: false };"
      : scenario === "failure"
        ? 'throw new Error("Controlled monitor failure");'
        : ["reminder", "longreminder", "overdue"].includes(scenario)
          ? `return context.host["catamorphic.sessions"].deliver({ sessionId: ${JSON.stringify(sessionId)}, content: "Reminder: submit the application.", mode: "message_only", attention: "required", idempotencyKey: "reminder" });`
          : scenario === "monitor"
            ? `return context.host["catamorphic.sessions"].deliver({ mode: "message_only", attention: "required", sessionId: ${JSON.stringify(sessionId)}, content: "Work completion observed.", idempotencyKey: "completion-observed" });`
            : `return context.host["catamorphic.sessions"].deliver({ sessionId: ${JSON.stringify(sessionId)}, content: "Scheduled follow-up received.", mode: "queue", idempotencyKey: "scheduled-wake" });`;
  return `import { defineWorkflow, trigger, type BoundaryContext } from "@catamorphic/workflow";
/** @displayname Session ${scenario} */
export const ${name} = defineWorkflow(({ defineBoundary }) => ({
  triggers: [${triggerConfig}],
  steps: [
    /** @displayname Check session */
    defineBoundary({ run: (context: BoundaryContext<unknown>) => { ${action} } }),
    /** @displayname Stop temporary activation */
    defineBoundary({ run: (context: BoundaryContext<unknown>) => context.host["catamorphic.sessions"].stop({ idempotencyKey: "stop" }) }),
  ],
}));`;
}

/** Terminal output without escape sequences, for e2e assertions. */
function cleanTerminalText(output: string): string {
  return (
    output
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strips OSC sequences from terminal output
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strips CSI sequences
      .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strips keypad mode toggles
      .replace(/\u001b[=>]/g, "")
      .trim()
  );
}
