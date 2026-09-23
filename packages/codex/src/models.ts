import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface CodexModel {
  id: string;
  name: string;
  description?: string;
  supportsEffort: boolean;
  supportedEffortLevels: ("low" | "medium" | "high" | "xhigh" | "max")[];
}

/** The model a Codex thread in this folder runs when none is pinned. */
export interface CodexDefaultModel {
  id: string;
  /** Catalog display name, when the catalog lists the model. */
  name?: string;
}

interface AppServerOptions {
  executable: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

type Request = (method: string, params: unknown) => Promise<unknown>;

/** Read the CLI's account-aware catalog without starting an agent turn. */
export async function listCodexModels(
  options: AppServerOptions,
): Promise<CodexModel[]> {
  return withAppServer(options, async (request) =>
    (await readCatalog(request)).map((entry) => entry.model),
  );
}

/**
 * The model Codex would run for a thread in `workingDirectory`, before any
 * turn: the effective `model` from its config layers (user, profile, and
 * project config as seen from that folder, via `config/read`), else the
 * catalog's own default (`model/list` `isDefault`). Null when neither
 * names one.
 */
export async function resolveCodexModel({
  workingDirectory,
  ...options
}: AppServerOptions & {
  workingDirectory: string;
}): Promise<CodexDefaultModel | null> {
  return withAppServer(options, async (request) => {
    const read = await request("config/read", { cwd: workingDirectory });
    const configured =
      isObject(read) &&
      isObject(read.config) &&
      typeof read.config.model === "string" &&
      read.config.model
        ? read.config.model
        : undefined;
    const catalog = await readCatalog(request);
    const entry = configured
      ? catalog.find((candidate) => candidate.model.id === configured)
      : catalog.find((candidate) => candidate.isDefault);
    const id = configured ?? entry?.model.id;
    if (!id) return null;
    return { id, ...(entry ? { name: entry.model.name } : {}) };
  });
}

async function readCatalog(
  request: Request,
): Promise<{ model: CodexModel; isDefault: boolean }[]> {
  const models = new Map<string, { model: CodexModel; isDefault: boolean }>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = await request("model/list", {
      limit: 100,
      includeHidden: false,
      ...(cursor ? { cursor } : {}),
    });
    if (!isObject(result) || !Array.isArray(result.data))
      throw new Error("Codex returned an invalid model catalog");
    for (const entry of result.data) {
      if (
        !isObject(entry) ||
        typeof entry.model !== "string" ||
        entry.hidden === true
      )
        continue;
      const levels = Array.isArray(entry.supportedReasoningEfforts)
        ? entry.supportedReasoningEfforts.flatMap(
            (option: unknown): CodexModel["supportedEffortLevels"] => {
              if (!isObject(option)) return [];
              const level = option.reasoningEffort;
              return level === "low" ||
                level === "medium" ||
                level === "high" ||
                level === "xhigh" ||
                level === "max"
                ? [level]
                : [];
            },
          )
        : [];
      models.set(entry.model, {
        model: {
          id: entry.model,
          name:
            typeof entry.displayName === "string"
              ? entry.displayName
              : entry.model,
          ...(typeof entry.description === "string"
            ? { description: entry.description }
            : {}),
          supportsEffort: levels.length > 0,
          supportedEffortLevels: levels,
        },
        isDefault: entry.isDefault === true,
      });
    }
    cursor =
      typeof result.nextCursor === "string" && result.nextCursor
        ? result.nextCursor
        : undefined;
    if (cursor && cursors.has(cursor))
      throw new Error("Codex repeated a model catalog page");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...models.values()];
}

/**
 * One short-lived `codex app-server`: initialize, run the caller's requests,
 * then stop the process — bounded in time and output, never orphaned.
 */
async function withAppServer<T>(
  { executable, env, timeoutMs = 15_000 }: AppServerOptions,
  run: (request: Request) => Promise<T>,
): Promise<T> {
  const child = spawn(executable, ["app-server"], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let sequence = 0;
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  // Drain stderr without exposing account/configuration details to the UI.
  child.stderr.resume();
  child.on("exit", () =>
    fail(new Error("Codex model discovery stopped before completing")),
  );
  const timeout = setTimeout(() => {
    fail(new Error("Codex model discovery timed out. Try again."));
    child.kill();
  }, timeoutMs);
  let bytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) {
      fail(new Error("Codex returned an oversized model catalog"));
      child.kill();
    }
  });
  lines.on("line", (line) => {
    try {
      const message: unknown = JSON.parse(line);
      if (!isObject(message) || typeof message.id !== "number") return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error)
        request.reject(
          new Error(
            "Codex could not list models. Check the agent's sign-in and try again.",
          ),
        );
      else request.resolve(message.result);
    } catch {
      fail(new Error("Codex returned an invalid model catalog response"));
    }
  });
  const request: Request = (method, params) => {
    if (failure) return Promise.reject(failure);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  };
  try {
    await request("initialize", {
      clientInfo: { name: "catamorphic", version: "0.0.1" },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    return await run(request);
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.stdin.end();
    child.kill();
    // A broken CLI must not leave an orphan after discovery.
    const killTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 1_000);
    killTimer.unref();
    child.once("exit", () => clearTimeout(killTimer));
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
