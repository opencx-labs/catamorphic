import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk/unstable";
import type {
  AgentEffort,
  AgentTurnUsage,
  JsonValue,
} from "@catamorphic/agent-protocol";
import {
  type AttemptControl,
  type AttemptHost,
  type AttemptStart,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessEvent,
  type HostToolDescriptor,
  type HostToolResult,
  type McpServerSpec,
  NO_CAPABILITIES,
} from "@catamorphic/agent-protocol/runner";
import {
  type LoopbackModel,
  loopbackModelEnv,
  loopbackModelHeaders,
  type ModelRefusal,
  renderUserMessage,
  serveLoopbackModel,
  writeCommandShell,
} from "@catamorphic/sandbox";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * What an Agent Client Protocol agent offers through the protocol itself.
 * Its session lives with the agent (`session/load` or `session/resume`
 * reopens it where it was made), so a chat moved elsewhere starts fresh
 * with a handoff.
 */
export const ACP_CAPABILITIES: HarnessCapabilities = {
  ...NO_CAPABILITIES,
  interrupt: true,
  approvals: true,
  streamsText: true,
  streamsReasoning: true,
  ids: { thread: "strong", turn: "none", item: "weak" },
};

/** Why an ACP agent without `acp.shell` does not run where commands run apart (ADR 0332). */
export const ACP_COMMANDS_APART_REFUSAL =
  'This Environment runs commands apart from the agent, and an ACP agent runs there only when its definition says both that every way it runs code goes through $SHELL ("shell": true) and that it loads no configuration, plugins, MCP servers, language servers, formatters or instructions from the checkout ("projectConfig": false, with "env" naming the variables that make it so). OpenCode does not: it loads plugins from the checkout whatever its settings say. Use Claude Code there, or run this Environment\'s commands beside the agent.';

/** The variables an agent's definition sets for its process. */
function definitionEnv(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]) &&
        typeof entry[1] === "string",
    ),
  );
}

/** How long an agent gets to exit after its turn before it is killed. */
const EXIT_GRACE_MS = 3_000;
/** How long an interrupted agent gets to end its turn before it is killed. */
const CANCEL_GRACE_MS = 10_000;

// ponytail: one agent process per attempt, its session reopened (and its
// history replayed) each turn. A warm process (ADR 0222's pattern) helps
// only the desktop and needs a host tool server that outlives attempts
// (ADR 0328).
/**
 * The ACP harness adapter (ADR 0050, 0241): runs one agent process per
 * attempt from `options.command` (`["hermes", "acp"]`) in the workspace,
 * speaks ACP over its stdio, and serves Work's host tools to it as a
 * loopback MCP server. On the host the agent uses its own configuration and
 * sign-in; in a sandbox with a model connection it reaches its model
 * through the gateway on loopback (ADR 0255).
 */
export function createAcpAdapter(input: { id?: string } = {}): HarnessAdapter {
  return {
    id: input.id ?? "acp",
    capabilities: () => ACP_CAPABILITIES,
    start: (attempt, host) => startAttempt(attempt, host),
  };
}

function startAttempt(
  attempt: AttemptStart,
  host: AttemptHost,
): AttemptControl {
  const command = Array.isArray(attempt.options.command)
    ? attempt.options.command.filter(
        (part): part is string => typeof part === "string",
      )
    : [];
  let child: ChildProcess | undefined;
  let tools: Server | undefined;
  let model: LoopbackModel | undefined;
  let connection: acp.ClientContext | undefined;
  let sessionId: string | undefined;
  let interrupted = false;
  /** Conversation updates the agent replayed while reopening its session. */
  let replayed = 0;
  /** Permission requests still waiting on their person. */
  const asks = new Set<AbortController>();
  const stderr: string[] = [];
  const items = new ItemStream(host);
  /** A model call the endpoint saw refused, until new output (ADR 0298). */
  let retrying = false;
  const providerRefused = (refusal: ModelRefusal) => {
    if (!items.live) return;
    retrying = true;
    host.emit({
      type: "provider.retrying",
      error: {
        message: refusal.message,
        kind: refusal.status === 429 ? "rate_limit" : "unavailable",
      },
      attempt: null,
      maxAttempts: null,
      retryAt: refusal.retryAt,
    });
  };
  /** A refused model call answered again: the provider is back. */
  const providerAnswered = () => {
    if (!retrying || !items.live) return;
    retrying = false;
    host.emit({ type: "provider.resumed" });
  };
  /** What the agent's `usage_update`s said: before the turn, and since. */
  const spend: {
    context?: { used: number; size: number };
    costBefore?: number;
    costNow?: number;
  } = {};

  const run = async (): Promise<"completed" | "cancelled"> => {
    const [executable, ...args] = command;
    if (!executable)
      throw new Error(
        'This ACP agent names no command. Set "acp": { "command": [...] } in its definition.',
      );
    // A model connection (ADR 0255): the gateway, served on loopback with
    // the grant read per request. Otherwise the agent's own configuration.
    const access = attempt.modelAccess;
    if (access.kind === "sign_in")
      throw new Error(
        "ACP agents run on their own sign-in or a model connection, not a Work sign-in.",
      );
    // Its commands apart from it (ADR 0332): only an agent whose
    // definition says it runs them with `$SHELL` can be pointed at the
    // command container; any other is refused, never run beside the agent.
    let shell: { shell: string; path: string } | undefined;
    if (attempt.commands) {
      // The contract (ADR 0332): every way it runs code goes through
      // $SHELL, and it loads nothing from the checkout, which the pull
      // request controls. Work cannot check either; the definition says so.
      if (
        attempt.options.shell !== true ||
        attempt.options.projectConfig !== false
      )
        throw new Error(ACP_COMMANDS_APART_REFUSAL);
      // With a harness user of its own, the provider's shim, which that
      // user cannot rewrite; otherwise one beside the runner's state.
      const harness = attempt.commands.harness;
      shell = harness
        ? {
            shell: path.join(harness.shim, "bin", "bash"),
            path: path.join(harness.shim, "path"),
          }
        : await writeCommandShell({
            directory: path.join(attempt.stateDirectory, "commands"),
            socket: attempt.commands.socket,
            runtime: process.execPath,
          });
    }
    const harness = attempt.commands?.harness;
    if (access.kind === "gateway")
      model = await serveLoopbackModel({
        access,
        onRefused: providerRefused,
        onAnswered: providerAnswered,
      });
    const spawned = spawn(executable, args, {
      // A harness of its own user starts in its home: its launcher (bunx,
      // npx, a Bun binary) would read bunfig.toml, .npmrc or .env files
      // from the checkout. Its session still works in the checkout.
      cwd: attempt.commands?.harness?.home ?? attempt.workingDirectory,
      env: {
        ...process.env,
        ...attempt.env,
        // What the definition sets for the agent (keeping project
        // configuration off, ADR 0332).
        ...definitionEnv(attempt.options.env),
        ...(model
          ? loopbackModelEnv({
              model,
              ...(attempt.model ? { modelId: attempt.model } : {}),
            })
          : {}),
        // Its shell, and Git first on its PATH, run where commands run.
        ...(shell
          ? {
              SHELL: shell.shell,
              PATH: [shell.path, attempt.env.PATH ?? process.env.PATH]
                .filter(Boolean)
                .join(":"),
            }
          : {}),
        // Its own user (ADR 0332): a home it writes as a cache, and a
        // configuration home it cannot write, so nothing it is led to
        // write loads into it as configuration or a plugin.
        ...(harness
          ? {
              HOME: harness.home,
              XDG_CONFIG_HOME: harness.config,
              XDG_DATA_HOME: path.join(harness.home, ".local", "share"),
              XDG_STATE_HOME: path.join(harness.home, ".local", "state"),
              XDG_CACHE_HOME: path.join(harness.home, ".cache"),
              TMPDIR: harness.temporary,
            }
          : {}),
      },
      ...(harness ? { uid: harness.uid, gid: harness.gid } : {}),
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so stopping it stops what it started too
      // (the agent behind an `npx` or `sh -c` command, its MCP servers).
      detached: process.platform !== "win32",
    });
    child = spawned;
    spawned.stderr.setEncoding("utf8");
    spawned.stderr.on("data", (chunk: string) => {
      stderr.push(...chunk.split("\n").filter((line) => line.trim()));
      stderr.splice(0, Math.max(0, stderr.length - 20));
    });
    // Ends the attempt when the agent goes away mid-request.
    const exited = new Promise<never>((_, reject) => {
      spawned.once("error", (error) =>
        reject(
          new Error(
            `Couldn't start ${path.basename(executable)}: ${error.message}. Install it or fix the agent's command.`,
          ),
        ),
      );
      spawned.once("exit", (code, signal) =>
        reject(
          new Error(
            `${path.basename(executable)} exited (${signal ?? `code ${code}`}) during the turn.${stderr.length ? `\n${stderr.slice(-5).join("\n")}` : ""}`,
          ),
        ),
      );
    });
    exited.catch(() => {});
    const until = <T>(promise: Promise<T>) => Promise.race([promise, exited]);

    const hostServers = attempt.hostTools.length
      ? await serveHostTools({
          tools: attempt.hostTools,
          call: (call) => callHostTool({ attempt, host, ...call }),
        })
      : undefined;
    tools = hostServers?.server;
    const mcpServers = [
      ...Object.entries(attempt.mcpServers).map(([name, spec]) =>
        acpMcpServer({ name, spec }),
      ),
      ...(hostServers?.servers ?? []),
    ];

    let agentName = path.basename(executable);
    const client = acp
      .client()
      .onNotification(
        acp.methods.client.session.update,
        ({ params: { update } }) => {
          // A reopened session's history, replayed before the turn starts.
          if (!items.live && REPLAYED.has(update.sessionUpdate)) replayed += 1;
          if (update.sessionUpdate === "usage_update") {
            spend.context = { used: update.used, size: update.size };
            const cost =
              update.cost?.currency === "USD" ? update.cost.amount : undefined;
            if (cost !== undefined) {
              if (items.live) spend.costNow = cost;
              else spend.costBefore = cost;
            }
          }
          // New output from the model (words, thoughts, a tool call or a
          // plan): its provider answers again.
          if (LIVE_OUTPUT.has(update.sessionUpdate)) providerAnswered();
          items.update(update);
        },
      )
      .onRequest(
        acp.methods.client.session.requestPermission,
        async ({ params: { toolCall, options } }) => {
          // Asked before the agent read the cancel: nobody is left to answer.
          if (interrupted) return { outcome: { outcome: "cancelled" } };
          const withdrawn = new AbortController();
          asks.add(withdrawn);
          const action = toolCall.title ?? "Run a tool";
          try {
            const response = await host.request(
              `permission:${toolCall.toolCallId}:${randomBytes(4).toString("hex")}`,
              {
                kind: "approval",
                blocking: true,
                title: action,
                origin: {
                  kind: "provider",
                  id: agentName,
                  displayName: agentName,
                },
                approval: {
                  action,
                  // What the agent says it is doing ("rm -rf build").
                  ...(toolCall.title ? { details: toolCall.title } : {}),
                  tool: {
                    server: null,
                    name: toolCall.name ?? toolCall.kind ?? "tool",
                    input: toJson(toolCall.rawInput),
                  },
                },
              },
              { signal: withdrawn.signal },
            );
            // A one-time answer never becomes the agent's "always": offered
            // no "once", an approval is a refusal and a refusal is the
            // request cancelled.
            const approved =
              response.kind === "approval" && response.decision === "approved";
            const always =
              response.kind === "approval" && response.remember === "always";
            const kinds: acp.PermissionOptionKind[] = approved
              ? always
                ? ["allow_always", "allow_once"]
                : ["allow_once", "reject_once"]
              : always
                ? ["reject_always", "reject_once"]
                : ["reject_once"];
            const option = kinds
              .map((kind) =>
                options.find((candidate) => candidate.kind === kind),
              )
              .find((candidate) => candidate !== undefined);
            return {
              outcome: option
                ? { outcome: "selected", optionId: option.optionId }
                : { outcome: "cancelled" },
            };
          } catch {
            // Withdrawn by an interrupt, or ended unanswered.
            return { outcome: { outcome: "cancelled" } };
          } finally {
            asks.delete(withdrawn);
          }
        },
      );
    connection = client.connect(
      acp.ndJsonStream(
        Writable.toWeb(spawned.stdin),
        Readable.toWeb(spawned.stdout),
      ),
    ).agent;

    const initialized = await until(
      connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "work", version: "1" },
      }),
    );
    agentName =
      initialized.agentInfo?.title ?? initialized.agentInfo?.name ?? agentName;
    const capabilities = initialized.agentCapabilities;
    // An agent that takes its providers from its client (ACP's unstable
    // `providers/set`) is pointed at the gateway that way too; one that
    // fails at it still has the variables.
    if (model && capabilities?.providers)
      await until(pointProviders({ connection, model })).catch(
        (error: unknown) =>
          host.emit({
            type: "diagnostic",
            level: "warn",
            message: `${agentName} did not take the gateway as its provider (${error instanceof Error ? error.message : String(error)}); it has WORK_MODEL_BASE_URL.`,
          }),
      );
    const earlier =
      attempt.thread.mode === "resume" || attempt.thread.mode === "restore"
        ? attempt.thread.nativeRef.id
        : undefined;
    // The earlier session reopens with `session/load` when the agent
    // offers it, else `session/resume`. Load replays the history first
    // (which the stream ignores until the turn starts), and that replay is
    // the proof the session is there: Work only reports a session once a
    // turn ran on it, while an agent may answer for one it lost without an
    // error (Hermes returns nothing, and its resume opens another session
    // under a new id).
    const reopen = capabilities?.loadSession
      ? "load"
      : capabilities?.sessionCapabilities?.resume
        ? "resume"
        : undefined;
    let reopened = false;
    let refused: string | undefined;
    /** The session's options as the agent last described them. */
    let options: acp.SessionConfigOption[] | null | undefined;
    if (earlier && reopen) {
      const session: acp.LoadSessionRequest = {
        sessionId: earlier,
        cwd: attempt.workingDirectory,
        mcpServers,
      };
      let loaded = false;
      try {
        const restored =
          reopen === "resume"
            ? await until(
                connection.request(acp.methods.agent.session.resume, session),
              )
            : await until(
                connection.request(acp.methods.agent.session.load, session),
              );
        options = restored?.configOptions;
        loaded = true;
      } catch (error) {
        // Only the agent's own answer that the session is gone counts: a
        // crash, an interrupt, a sign-in or a passing error ends this turn
        // and leaves the session to the next one. An agent that answers a
        // lost session with a plain internal error (OpenCode's "service
        // failure") shows it is gone by no longer listing it.
        const gone =
          sessionGone(error) ||
          (error instanceof acp.RequestError &&
            !PASSING_CODES.has(error.code) &&
            Boolean(capabilities?.sessionCapabilities?.list) &&
            !(await listsSession({
              connection,
              sessionId: earlier,
              until,
            }).catch(() => true)));
        if (interrupted || !gone) throw error;
        refused = error instanceof Error ? error.message : String(error);
      }
      reopened = loaded && (reopen === "resume" || replayed > 0);
      // A load that replayed nothing: Hermes answers so for a session it
      // lost, and for one it failed to restore. One it still lists is there,
      // so this turn fails and the next tries again.
      if (loaded && !reopened) {
        if (
          capabilities?.sessionCapabilities?.list &&
          (await listsSession({ connection, sessionId: earlier, until }))
        )
          throw new Error(
            `${agentName} couldn't load its earlier session, though it still has it. Send your message again to retry.`,
          );
        refused = "it replayed none of it";
      }
    }
    // The earlier session is gone (refused, or the agent no longer reopens
    // sessions): Work is told, and runs the turn again on a new thread that
    // is handed the conversation (ADR 0245).
    if (earlier && !reopened) {
      const reason = `${agentName} couldn't reopen its earlier session${refused ? ` (${refused})` : ""}.`;
      host.emit({ type: "thread.lost", reason });
      throw new Error(reason);
    }
    let opened: string;
    if (reopened && earlier) opened = earlier;
    else {
      const created = await until(
        connection.request(acp.methods.agent.session.new, {
          cwd: attempt.workingDirectory,
          mcpServers,
        }),
      );
      opened = created.sessionId;
      options = created.configOptions;
    }
    sessionId = opened;
    // The definition's model and effort, where the agent offers them
    // (ADR 0255, 0328); what it cannot take is told once the turn starts.
    const unapplied: Extract<HarnessEvent, { type: "setting.unapplied" }>[] =
      [];
    const agent = connection;
    const setOption = async (option: { configId: string; value: string }) => {
      const answer = await until(
        agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId: opened,
          ...option,
        }),
      );
      // An agent's effort levels follow its model: read them again.
      options = answer?.configOptions ?? options;
    };
    let modelChosen = false;
    if (attempt.model) {
      const choice = modelChoice({ options, model: attempt.model });
      if (choice?.kind === "set")
        await setOption(choice).then(
          () => {
            modelChosen = true;
          },
          (error: unknown) =>
            unapplied.push({
              type: "setting.unapplied",
              setting: "model",
              requested: attempt.model ?? "",
              reason: `${agentName} refused the model ${attempt.model}: ${error instanceof Error ? error.message : String(error)}`,
            }),
        );
      else if (choice?.kind === "chosen") modelChosen = true;
      else if (choice?.kind === "unknown")
        unapplied.push({
          type: "setting.unapplied",
          setting: "model",
          requested: attempt.model,
          reason: `${agentName} offers no model ${attempt.model}; it offers ${listed(choice.offered)}.`,
        });
    }
    if (attempt.effort) {
      const effort = attempt.effort;
      const choice = effortChoice({ options, effort });
      const unapply = (reason: string) =>
        unapplied.push({
          type: "setting.unapplied",
          setting: "effort",
          requested: effort,
          reason,
        });
      if (choice.kind === "set")
        await setOption(choice).catch((error: unknown) =>
          unapply(
            `${agentName} refused effort ${effort}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      else if (choice.kind === "unknown")
        unapply(
          `${agentName} offers no effort ${effort}${modelChosen ? ` for ${attempt.model}` : ""}; it offers ${listed(choice.offered)}. The turn runs at its own setting.`,
        );
      else if (choice.kind === "absent")
        unapply(
          `${agentName} offers no effort setting${modelChosen ? ` for ${attempt.model}` : ""}, so effort ${effort} is not applied.`,
        );
    }
    // Work hears of a session once it holds the conversation and can be
    // reopened: a reopened one at once, a new one after its first turn ends
    // (an interrupted one starts afresh, told Work's instructions again),
    // and never one the agent cannot reopen, so that Work hands the agent
    // the whole conversation each turn instead.
    const report = () =>
      host.emit({ type: "thread", ref: { id: opened, strength: "strong" } });
    if (reopened) report();
    if (interrupted) return "cancelled";
    host.emit({ type: "turn.started" });
    for (const event of unapplied) host.emit(event);
    items.live = true;
    const answer = await until(
      connection.request(acp.methods.agent.session.prompt, {
        sessionId: opened,
        prompt: promptBlocks({
          attempt,
          takesImages: capabilities?.promptCapabilities?.image === true,
          newSession: !reopened,
        }),
      }),
    );
    const usage = turnUsage({
      usage: answer?.usage,
      spend,
      newSession: !reopened,
      ...(modelChosen && attempt.model ? { model: attempt.model } : {}),
    });
    if (usage) host.emit({ type: "usage", usage });
    // Only Work's interrupt makes the turn interrupted: an agent that ends
    // its own turn as cancelled (a request it was told no to) finished it.
    const outcome = interrupted ? "cancelled" : "completed";
    if (!reopened && reopen && outcome === "completed") report();
    return outcome;
  };

  // The turn ends once the agent's process has, so an agent that saves its
  // session as it exits (Hermes) has saved it before a next attempt, such
  // as the restart a mid-turn message causes, reopens it.
  const finished = run()
    .then(
      (outcome) => ({ outcome, error: undefined }),
      (error: unknown) => ({
        outcome: interrupted ? ("cancelled" as const) : ("failed" as const),
        error,
      }),
    )
    .then(async ({ outcome, error }) => {
      items.live = false;
      items.closeAll(outcome);
      tools?.close();
      tools?.closeAllConnections();
      await stop(child);
      // After the agent, so a call it made on the way out still lands.
      model?.close();
      host.emit({
        type: "turn.completed",
        status:
          outcome === "completed"
            ? "completed"
            : outcome === "cancelled"
              ? "interrupted"
              : "failed",
        ...(outcome === "failed"
          ? {
              error: {
                message: error instanceof Error ? error.message : String(error),
              },
            }
          : {}),
      });
    });

  return {
    // ponytail: ACP has no steer; core restarts the attempt with the input.
    steer: async () => false,
    interrupt: () => {
      interrupted = true;
      for (const ask of asks) ask.abort();
      if (connection && sessionId)
        void connection
          .notify(acp.methods.agent.session.cancel, { sessionId })
          .catch(() => {});
      else if (child) signal({ child, name: "SIGTERM" });
      // An agent that ignores the cancel, and the stop, is killed.
      const timer = setTimeout(
        () => child && signal({ child, name: "SIGKILL" }),
        CANCEL_GRACE_MS,
      );
      void finished.finally(() => clearTimeout(timer));
    },
    finished,
  };
}

/**
 * Points every provider the agent lists that speaks the model's API at the
 * loopback gateway (ACP's unstable `providers/set`), with the key Work gave
 * it, and turns off the optional ones that speak another API, so none
 * reaches a model around the gateway's policy.
 */
async function pointProviders(input: {
  connection: acp.ClientContext;
  model: LoopbackModel;
}): Promise<void> {
  const { connection, model } = input;
  const { providers } = await connection.request(
    acp.methods.agent.providers.list,
    {},
  );
  for (const provider of providers)
    if (provider.supported.includes(model.api))
      await connection.request(acp.methods.agent.providers.set, {
        providerId: provider.providerId,
        apiType: model.api,
        baseUrl: model.baseUrl,
        headers: loopbackModelHeaders(model),
      });
    else if (!provider.required)
      await connection.request(acp.methods.agent.providers.disable, {
        providerId: provider.providerId,
      });
}

/**
 * The definition's model as the agent's model option (by id, else by name,
 * else the one value ending in `/<model>`): to set, already chosen, or
 * unknown to the agent with what it offers instead. Undefined when the
 * agent offers no model option.
 */
export function modelChoice(input: {
  options: readonly acp.SessionConfigOption[] | null | undefined;
  model: string;
}):
  | { kind: "set"; configId: string; value: string }
  | { kind: "chosen" }
  | { kind: "unknown"; offered: string[] }
  | undefined {
  let offered: string[] | undefined;
  for (const option of input.options ?? []) {
    if (option.category !== "model" || option.type !== "select") continue;
    const values = option.options.flatMap((entry) =>
      "group" in entry ? entry.options : [entry],
    );
    const suffixed = values.filter((value) =>
      value.value.endsWith(`/${input.model}`),
    );
    const match =
      values.find((value) => value.value === input.model) ??
      values.find((value) => value.name === input.model) ??
      (suffixed.length === 1 ? suffixed[0] : undefined);
    if (!match) {
      offered = [...(offered ?? []), ...values.map((value) => value.value)];
      continue;
    }
    return match.value === option.currentValue
      ? { kind: "chosen" }
      : { kind: "set", configId: option.id, value: match.value };
  }
  return offered ? { kind: "unknown", offered } : undefined;
}

/**
 * The attempt's effort as the agent's thought level option (ADR 0328): a
 * value or name equal to the level, to set or already chosen; unknown to
 * the agent with what it offers instead; or `absent` when it offers no
 * thought level to choose.
 */
export function effortChoice(input: {
  options: readonly acp.SessionConfigOption[] | null | undefined;
  effort: AgentEffort;
}):
  | { kind: "set"; configId: string; value: string }
  | { kind: "chosen" }
  | { kind: "unknown"; offered: string[] }
  | { kind: "absent" } {
  const option = (input.options ?? []).find(
    (candidate) =>
      candidate.category === "thought_level" && candidate.type === "select",
  );
  if (option?.type !== "select") return { kind: "absent" };
  const values = option.options.flatMap((entry) =>
    "group" in entry ? entry.options : [entry],
  );
  const match =
    values.find((value) => value.value === input.effort) ??
    values.find((value) => value.name.toLowerCase() === input.effort);
  if (!match)
    return { kind: "unknown", offered: values.map((value) => value.value) };
  return match.value === option.currentValue
    ? { kind: "chosen" }
    : { kind: "set", configId: option.id, value: match.value };
}

/**
 * The turn's usage from what the agent said (ADR 0328): its prompt answer's
 * tokens (unstable in ACP), the context its last `usage_update` reported,
 * and the session cost it reported in USD less what it reported before the
 * turn (nothing before a new session's first). Undefined when it said none.
 */
export function turnUsage(input: {
  usage: acp.Usage | null | undefined;
  spend: {
    context?: { used: number; size: number };
    costBefore?: number;
    costNow?: number;
  };
  newSession: boolean;
  model?: string;
}): AgentTurnUsage | undefined {
  const { usage, spend } = input;
  const before = spend.costBefore ?? (input.newSession ? 0 : undefined);
  const cost =
    spend.costNow !== undefined && before !== undefined
      ? Math.max(0, spend.costNow - before)
      : undefined;
  const counted: AgentTurnUsage = {
    ...(usage
      ? {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ...(usage.cachedReadTokens
            ? { cachedInputTokens: usage.cachedReadTokens }
            : {}),
          ...(usage.cachedWriteTokens
            ? { cacheCreationTokens: usage.cachedWriteTokens }
            : {}),
          ...(usage.thoughtTokens
            ? { reasoningTokens: usage.thoughtTokens }
            : {}),
        }
      : {}),
    ...(cost !== undefined ? { costUsd: cost } : {}),
    ...(spend.context
      ? {
          contextTokens: spend.context.used,
          contextWindow: spend.context.size,
        }
      : {}),
  };
  if (Object.keys(counted).length === 0) return undefined;
  return input.model ? { model: input.model, ...counted } : counted;
}

/** Values an agent offers, named in a notice: the first ten, then a count. */
function listed(values: readonly string[]): string {
  if (values.length === 0) return "nothing";
  const shown = values.slice(0, 10).join(", ");
  return values.length > 10 ? `${shown} and ${values.length - 10} more` : shown;
}

/** Signals the agent and everything it started, its process group. */
function signal(input: { child: ChildProcess; name: NodeJS.Signals }): void {
  const { child, name } = input;
  try {
    if (child.pid !== undefined && process.platform !== "win32")
      process.kill(-child.pid, name);
    else child.kill(name);
  } catch {
    // The group is gone: the agent alone, if it is still there.
    child.kill(name);
  }
}

/**
 * Ends an agent process: its input closes so it can exit on its own (Hermes
 * does in under a second, saving its session), then it is asked to stop,
 * then killed.
 */
async function stop(child: ChildProcess | undefined): Promise<void> {
  // A command that never started has no process to end.
  if (
    child?.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.stdin?.end();
  const term = setTimeout(
    () => signal({ child, name: "SIGTERM" }),
    EXIT_GRACE_MS,
  );
  const kill = setTimeout(
    () => signal({ child, name: "SIGKILL" }),
    2 * EXIT_GRACE_MS,
  );
  await exited;
  clearTimeout(term);
  clearTimeout(kill);
}

/**
 * The prompt: Work's instructions on a new session's first turn, the
 * turn's context (ADR 0152), and the person's words, each a block of its
 * own so the context never reads as theirs. Images go along when the agent
 * takes them; otherwise every media attachment is named as not delivered.
 */
function promptBlocks({
  attempt,
  takesImages,
  newSession,
}: {
  attempt: AttemptStart;
  takesImages: boolean;
  newSession: boolean;
}): acp.ContentBlock[] {
  const input = attempt.input ?? { itemId: "", text: "", attachments: [] };
  const media = input.attachments.filter((item) => item.kind !== "text");
  const delivered = takesImages && media.every((item) => item.kind === "image");
  const blocks: acp.ContentBlock[] = [];
  const instructions = newSession ? attempt.systemPrompt.trim() : "";
  if (instructions)
    blocks.push({
      type: "text",
      text: `<work-instructions>\n${instructions}\n</work-instructions>`,
    });
  if (attempt.context.trim())
    blocks.push({
      type: "text",
      text: `<work-context>\n${attempt.context.trim()}\n</work-context>`,
    });
  blocks.push({
    type: "text",
    text: renderUserMessage(input.text, input.attachments, {
      omitMedia: !delivered,
    }),
  });
  if (delivered)
    for (const item of media)
      if (item.kind === "image")
        blocks.push({
          type: "image",
          data: item.dataBase64,
          mimeType: item.mediaType,
        });
  return blocks;
}

/** A server the attempt names, as ACP describes MCP servers. */
function acpMcpServer({
  name,
  spec,
}: {
  name: string;
  spec: McpServerSpec;
}): acp.McpServer {
  if (spec.transport === "stdio")
    return {
      name,
      command: spec.command,
      args: spec.args ?? [],
      env: Object.entries(spec.env ?? {}).map(([key, value]) => ({
        name: key,
        value,
      })),
    };
  return {
    type: spec.transport,
    name,
    url: spec.url,
    headers: Object.entries(spec.headers ?? {}).map(([key, value]) => ({
      name: key,
      value,
    })),
  };
}

/**
 * A host tool the agent called over MCP (ADR 0198: a host call), decided by
 * the attempt's tool policy first.
 */
async function callHostTool(input: {
  attempt: AttemptStart;
  host: AttemptHost;
  tool: HostToolDescriptor;
  arguments: JsonValue;
}): Promise<CallToolResult> {
  const { tool, host } = input;
  const failure = (text: string): CallToolResult => ({
    content: [{ type: "text", text }],
    isError: true,
  });
  const server = tool.server ?? "workspace";
  if (input.attempt.toolPolicies[server]) {
    const verdict = await host.authorize({
      server,
      tool: tool.name,
      input: input.arguments,
    });
    if (!verdict.allowed) return failure(verdict.message);
  }
  let result: HostToolResult;
  try {
    result = await host.callTool({ name: tool.name, input: input.arguments });
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
  const structured = result.structured;
  return {
    content: result.content.map((part) =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "image", data: part.data, mimeType: part.mimeType },
    ),
    ...(structured &&
    typeof structured === "object" &&
    !Array.isArray(structured)
      ? { structuredContent: structured }
      : {}),
    ...(result.isError ? { isError: true } : {}),
  };
}

/**
 * Host tools as loopback MCP servers, one per server key (`workspace`
 * unless a tool names its own), at `/<server>` behind a bearer only this
 * attempt's agent is given. Stateless: every request gets its own server.
 */
async function serveHostTools(input: {
  tools: readonly HostToolDescriptor[];
  call: (call: {
    tool: HostToolDescriptor;
    arguments: JsonValue;
  }) => Promise<CallToolResult>;
}): Promise<{ server: Server; servers: acp.McpServer[] }> {
  const byServer = new Map<string, HostToolDescriptor[]>();
  for (const tool of input.tools) {
    const key = tool.server ?? "workspace";
    byServer.set(key, [...(byServer.get(key) ?? []), tool]);
  }
  // Served at their encoded paths, matched as sent: nothing a request
  // carries is decoded before its bearer is checked.
  const byPath = new Map(
    [...byServer].map(([name, tools]) => [
      `/${encodeURIComponent(name)}`,
      tools,
    ]),
  );
  const token = randomBytes(32).toString("hex");
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    const tools = byPath.get((request.url ?? "").split("?")[0] ?? "");
    if (!tools) {
      response.writeHead(404).end();
      return;
    }
    const mcp = new McpServer(
      { name: "work", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: { ...tool.inputSchema, type: "object" as const },
      })),
    }));
    mcp.server.setRequestHandler(CallToolRequestSchema, async (call) => {
      const tool = tools.find(
        (candidate) => candidate.name === call.params.name,
      );
      return tool
        ? input.call({ tool, arguments: toJson(call.params.arguments ?? {}) })
        : {
            content: [
              { type: "text", text: `Unknown tool: ${call.params.name}` },
            ],
            isError: true,
          };
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    mcp
      .connect(transport)
      .then(() => transport.handleRequest(request, response))
      .catch(() => {
        if (!response.headersSent) response.writeHead(500).end();
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    server,
    // ponytail: HTTP even when the agent does not advertise it (Hermes takes
    // HTTP MCP servers without saying so); a stdio bridge would serve the
    // agents that cannot.
    servers: [...byServer.keys()].map((name) => ({
      type: "http" as const,
      name,
      url: `http://127.0.0.1:${port}/${encodeURIComponent(name)}`,
      headers: [{ name: "Authorization", value: `Bearer ${token}` }],
    })),
  };
}

/** Updates that are the model's own output in a turn. */
const LIVE_OUTPUT: ReadonlySet<string> = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);

/** The conversation updates an agent replays from a session it reopens. */
const REPLAYED: ReadonlySet<string> = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
]);

/** How many pages of an agent's sessions to look through for one. */
const LIST_PAGES = 10;

/**
 * Whether the agent lists the session among its own, most recent first by
 * its own order, a page at a time. A failure to list is passing: it throws.
 */
async function listsSession(input: {
  connection: acp.ClientContext;
  sessionId: string;
  until: <T>(promise: Promise<T>) => Promise<T>;
}): Promise<boolean> {
  let cursor: string | undefined;
  for (let page = 0; page < LIST_PAGES; page++) {
    const { sessions, nextCursor } = await input.until(
      input.connection.request(
        acp.methods.agent.session.list,
        cursor ? { cursor } : {},
      ),
    );
    if (sessions.some((listed) => listed.sessionId === input.sessionId))
      return true;
    if (!nextCursor) return false;
    cursor = nextCursor;
  }
  return false;
}

/** What a refused reopen answers when the session is gone for good. */
const GONE_CODES: ReadonlySet<number> = new Set([
  acp.RequestError.resourceNotFound().code,
  acp.RequestError.invalidParams().code,
  acp.RequestError.methodNotFound("").code,
]);
/** What it answers when something passing stood in the way. */
const PASSING_CODES: ReadonlySet<number> = new Set([
  acp.RequestError.authRequired().code,
  acp.RequestError.requestCancelled().code,
]);

/**
 * Whether a refused reopen says the session is gone, rather than something
 * passing: not found, a session id the agent does not take, or a method it
 * does not have; never a sign-in or a cancel. An agent that throws a plain
 * error answers "Internal error", its words in the error's data.
 */
function sessionGone(error: unknown): error is acp.RequestError {
  if (!(error instanceof acp.RequestError)) return false;
  if (GONE_CODES.has(error.code)) return true;
  if (PASSING_CODES.has(error.code)) return false;
  return /not found|no such|unknown session|invalid session|does ?n[o']t exist/i.test(
    `${error.message} ${JSON.stringify(error.data ?? null)}`,
  );
}

function toJson(value: unknown): JsonValue {
  const parsed: JsonValue = JSON.parse(JSON.stringify(value ?? null));
  return parsed;
}

/**
 * Turns `session/update` notifications into the attempt's items: a run of
 * message or thought chunks is one item, each tool call one item. Nothing
 * is said before the turn starts (a reopened session's replayed history).
 */
class ItemStream {
  live = false;
  private open:
    | { key: string; kind: "assistant_message" | "reasoning" }
    | undefined;
  private readonly tools = new Set<string>();
  /** Calls already finished: a late update for one says nothing new. */
  private readonly done = new Set<string>();
  private count = 0;

  constructor(private readonly host: AttemptHost) {}

  update(update: acp.SessionUpdate): void {
    if (!this.live) return;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        if (update.content.type !== "text") return;
        const kind =
          update.sessionUpdate === "agent_message_chunk"
            ? "assistant_message"
            : "reasoning";
        if (this.open?.kind !== kind) {
          this.closeText();
          const key = `${kind}:${++this.count}`;
          this.open = { key, kind };
          this.host.emit({
            type: "item.started",
            key,
            item:
              kind === "assistant_message"
                ? { kind, text: "", agentId: null }
                : { kind, text: "" },
          });
        }
        this.host.emit({
          type: "item.delta",
          key: this.open.key,
          field: "text",
          text: update.content.text,
        });
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        const key = `tool:${update.toolCallId}`;
        if (this.done.has(key)) return;
        this.closeText();
        if (!this.tools.has(key)) {
          this.tools.add(key);
          this.host.emit({
            type: "item.started",
            key,
            ref: { id: update.toolCallId, strength: "weak" },
            item: {
              kind: "tool_call",
              // Agents without a tool name title the call with it
              // (`mcp__workspace__lookup`), which the chat reads.
              tool: update.name ?? update.title ?? update.kind ?? "tool",
              server: null,
              description: update.title ?? null,
              input: toJson(update.rawInput ?? {}),
              result: null,
              error: null,
            },
          });
        } else if (update.title || update.rawInput !== undefined) {
          this.host.emit({
            type: "item.updated",
            key,
            item: {
              ...(update.title ? { description: update.title } : {}),
              ...(update.rawInput !== undefined
                ? { input: toJson(update.rawInput) }
                : {}),
            },
          });
        }
        if (update.status === "completed" || update.status === "failed") {
          this.tools.delete(key);
          this.done.add(key);
          const output = toolOutput(update);
          this.host.emit({
            type: "item.completed",
            key,
            status: update.status,
            item:
              update.status === "failed"
                ? {
                    error:
                      typeof output === "string"
                        ? output
                        : JSON.stringify(output),
                  }
                : { result: output },
          });
        }
        return;
      }
      default:
        return;
    }
  }

  /** Ends every open item, as the turn ends. */
  closeAll(status: "completed" | "failed" | "cancelled"): void {
    this.closeText();
    // A call the agent never finished did not run to its end.
    for (const key of this.tools)
      this.host.emit({
        type: "item.completed",
        key,
        status: status === "failed" ? "failed" : "cancelled",
      });
    this.tools.clear();
  }

  private closeText(): void {
    if (!this.open) return;
    this.host.emit({
      type: "item.completed",
      key: this.open.key,
      status: "completed",
    });
    this.open = undefined;
  }
}

/** What a finished tool call said: its raw output, else its text content. */
function toolOutput(update: acp.ToolCallUpdate): JsonValue {
  if (update.rawOutput !== undefined && update.rawOutput !== null)
    return toJson(update.rawOutput);
  const text = (update.content ?? [])
    .flatMap((part) =>
      part.type === "content" && part.content.type === "text"
        ? [part.content.text]
        : [],
    )
    .join("\n");
  return text;
}
