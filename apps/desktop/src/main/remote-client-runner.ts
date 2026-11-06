import { createPrivateKey } from "node:crypto";
import { createApiClient } from "@catamorphic/api-client";
import { clientExecutor, RemoteOperationResultSchema } from "@catamorphic/core";
import type { SandboxProvider } from "@catamorphic/sandbox";
import {
  ReceiptRefusedError,
  ResultRejectedError,
  RunnerSessionEndedError,
  startClientRunner,
} from "@catamorphic/server-sdk";
import type { ProfileConfigManager } from "./profile-config.js";
import { refreshRemoteCredentials } from "./remote-oauth.js";

/**
 * How long a replica may serve roles and project policy from before a
 * change: the stock roles cache (10 seconds) over a program fetch it may
 * have memoized just before (5 seconds), plus a margin (issue 154).
 */
const REFUSAL_CONFIRM_MS = 16_000;

/** This registration no longer matters: stopped, or another Environment. */
class RegistrationSupersededError extends Error {
  constructor() {
    super("This machine no longer serves this Environment");
    this.name = "RegistrationSupersededError";
  }
}

/** Resolves after `ms`, or rejects as superseded once `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new RegistrationSupersededError());
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(new RegistrationSupersededError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** The server refused this machine: retrying cannot help. */
class RunnerAccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerAccessDeniedError";
  }
}

/**
 * The server's definite answers become the runner's errors (ADR 0187);
 * anything else (a 5xx, a timeout, no answer) is transient and retried.
 */
function refusal(args: {
  status: number;
  error: { error?: string } | undefined;
  receipt?: boolean;
}): Error {
  const message = args.error?.error ?? `The server answered ${args.status}`;
  if (args.status >= 500 || args.status === 408 || args.status === 429)
    return new Error(message);
  if (args.receipt && args.status === 409)
    return new ReceiptRefusedError(message);
  if (args.receipt && (args.status === 400 || args.status === 413))
    return new ResultRejectedError(message);
  return new RunnerSessionEndedError(message);
}

/** Per-project authenticated runner, independent of desktop's local root API. */
export class RemoteClientRunners {
  private readonly runners = new Map<
    string,
    {
      environment: string;
      started: Promise<ReturnType<typeof startClientRunner>>;
    }
  >();
  /** The Environment each project's member asked this machine to serve. */
  private readonly wanted = new Map<string, string>();
  private readonly retries = new Map<string, NodeJS.Timeout>();
  /** False while the computer sleeps or Work shuts down. */
  private active = true;
  /** Aborts registrations in flight when the computer sleeps or Work quits. */
  private halt = new AbortController();
  constructor(
    private readonly profiles: ProfileConfigManager,
    private readonly provider: SandboxProvider,
  ) {}
  async connect(args: {
    projectId: string;
    environment: string;
  }): Promise<{ id: string }> {
    const stores = this.profiles.forProject(args.projectId);
    const store = stores.remoteProjects;
    const inspected = store.inspect(args.projectId);
    if (!inspected) throw new Error("Project has no remote server");
    this.wanted.set(args.projectId, args.environment);
    // An explicit connect replaces any pending retry for this project.
    const pending = this.retries.get(args.projectId);
    if (pending) clearTimeout(pending);
    this.retries.delete(args.projectId);
    const link = inspected.link;
    const client = createApiClient({
      baseUrl: link.serverUrl.replace(/\/api\/?$/, ""),
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const token = await store.accessToken(args.projectId, {
          refresh: (credentials) => refreshRemoteCredentials({ credentials }),
        });
        request.headers.set("authorization", `Bearer ${token}`);
        // A poll waits up to 20 seconds on the server.
        return fetch(request, {
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(30000)]),
        });
      },
    });
    const existing = this.runners.get(args.projectId);
    if (existing && existing.environment !== args.environment) {
      // Another Environment: end the old connection before registering the
      // new one under the same runner id.
      this.runners.delete(args.projectId);
      await existing.started.then((old) => old.stop()).catch(() => {});
    }
    let runner = this.runners.get(args.projectId)?.started;
    if (!runner) {
      let failed = false;
      const halted = this.halt.signal;
      const superseded = () =>
        halted.aborted || this.wanted.get(args.projectId) !== args.environment;
      const started: Promise<ReturnType<typeof startClientRunner>> =
        (async () => {
          // Operations reach this machine sealed to its profile's key
          // (ADR 0207); the private half never leaves the profile.
          const keys = stores.runnerKey.keyPair();
          const privateKey = createPrivateKey(keys.privateKey);
          const register = () =>
            client.POST("/api/projects/{projectId}/client-runners", {
              signal: halted,
              params: { path: { projectId: link.remoteProjectId } },
              body: {
                id: link.connectionId,
                environment: args.environment,
                label: "This machine",
                workspaceRoot: this.provider.workspaceRoot,
                resourceLimits: [...(this.provider.resourceLimits ?? [])],
                isolation: this.provider.isolation ?? "none",
                processes: Boolean(this.provider.processes),
                capabilities: [...(this.provider.capabilities ?? [])],
                publicKey: keys.publicKey,
              },
            });
          let registration = await register();
          // A replica may still hold roles and project policy cached from
          // before a change that grants this machine (issue 154): confirm
          // a refusal once that window has passed before believing it.
          if (registration.response.status === 403) {
            await pause(REFUSAL_CONFIRM_MS, halted);
            if (superseded()) throw new RegistrationSupersededError();
            registration = await register();
          }
          if (!registration.data) {
            const message =
              registration.error?.error ?? "Local execution could not connect";
            throw registration.response.status === 403
              ? new RunnerAccessDeniedError(message)
              : new Error(message);
          }
          const lease = registration.data;
          return startClientRunner({
            provider: this.provider,
            keys: {
              executor: clientExecutor(link.connectionId),
              privateKeys: () => [privateKey],
            },
            transport: {
              renew: async () => {
                const response = await client.POST(
                  "/api/client-runners/renew",
                  { body: lease },
                );
                if (response.error)
                  throw refusal({
                    status: response.response.status,
                    error: response.error,
                  });
              },
              poll: async ({ pollId, max, signal }) => {
                const response = await client.POST("/api/client-runners/poll", {
                  body: { ...lease, pollId, max },
                  signal,
                });
                if (response.error)
                  throw refusal({
                    status: response.response.status,
                    error: response.error,
                  });
                return response.data ?? [];
              },
              complete: async (input) => {
                const result =
                  input.error !== undefined
                    ? undefined
                    : RemoteOperationResultSchema.safeParse(
                        input.response ?? null,
                      );
                if (result && !result.success)
                  throw new ResultRejectedError(
                    "The result is not one this server accepts",
                  );
                const response = await client.POST(
                  "/api/client-runners/complete",
                  {
                    body: {
                      ...lease,
                      jobId: input.jobId,
                      ...(result
                        ? { response: result.data }
                        : { error: input.error }),
                    },
                  },
                );
                if (response.error)
                  throw refusal({
                    status: response.response.status,
                    error: response.error,
                    receipt: true,
                  });
              },
              disconnect: async () => {
                await client.POST("/api/client-runners/disconnect", {
                  body: lease,
                });
              },
            },
            onError: (error) => {
              // A runner can report more than one failure (renew, then poll);
              // only its first ends it, and never a newer runner's entry.
              if (failed) return;
              failed = true;
              if (this.runners.get(args.projectId)?.started === started)
                this.runners.delete(args.projectId);
              console.warn("[desktop] Local runner stopped", error);
              // The server ended the session (its lease moved on, say after
              // a long sleep); this machine serves again once it registers.
              this.reconnect(args, 1);
            },
          });
        })();
      runner = started;
      this.runners.set(args.projectId, {
        environment: args.environment,
        started,
      });
      void started.catch(() => {
        if (this.runners.get(args.projectId)?.started === started)
          this.runners.delete(args.projectId);
      });
    }
    await runner;
    return { id: link.connectionId };
  }
  private reconnect(
    args: { projectId: string; environment: string },
    attempt: number,
  ) {
    if (
      !this.active ||
      this.wanted.get(args.projectId) !== args.environment ||
      this.retries.has(args.projectId)
    )
      return;
    if (
      !this.profiles
        .forProject(args.projectId)
        .remoteProjects.inspect(args.projectId)
    ) {
      this.wanted.delete(args.projectId);
      return;
    }
    const timer = setTimeout(
      () => {
        this.retries.delete(args.projectId);
        // The member may have chosen another Environment meanwhile.
        if (
          !this.active ||
          this.wanted.get(args.projectId) !== args.environment
        )
          return;
        void this.connect(args).catch((error: unknown) => {
          // Access taken away: stop until the member connects again.
          if (error instanceof RunnerAccessDeniedError) {
            this.wanted.delete(args.projectId);
            return;
          }
          this.reconnect(args, attempt + 1);
        });
      },
      Math.min(60_000, 2_000 * 2 ** (attempt - 1)),
    );
    timer.unref();
    this.retries.set(args.projectId, timer);
  }

  /** After sleep: serve again every project the member connected. */
  resume() {
    this.active = true;
    this.halt = new AbortController();
    for (const [projectId, environment] of this.wanted)
      if (!this.runners.has(projectId))
        this.reconnect({ projectId, environment }, 1);
  }

  /** On sleep or shutdown; `resume` serves the same projects again. */
  async stop() {
    this.active = false;
    // Registrations in flight give up at once instead of holding up sleep
    // or quit.
    this.halt.abort();
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    const runners = [...this.runners.values()];
    this.runners.clear();
    await Promise.allSettled(
      runners.map(async ({ started }) => (await started).stop()),
    );
  }
}
