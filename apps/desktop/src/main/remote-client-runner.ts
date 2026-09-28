import { createApiClient } from "@catamorphic/api-client";
import { ClientRunnerResultSchema } from "@catamorphic/core";
import type { SandboxProvider } from "@catamorphic/sandbox";
import { startClientRunner } from "@catamorphic/server-sdk";
import type { ProfileConfigManager } from "./profile-config.js";
import { refreshRemoteCredentials } from "./remote-oauth.js";

/** The server refused this machine: retrying cannot help. */
class RunnerAccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerAccessDeniedError";
  }
}

/** Per-project authenticated runner, independent of desktop's local root API. */
export class RemoteClientRunners {
  private readonly runners = new Map<
    string,
    Promise<ReturnType<typeof startClientRunner>>
  >();
  /** The Environment each project's member asked this machine to serve. */
  private readonly wanted = new Map<string, string>();
  private readonly retries = new Map<string, NodeJS.Timeout>();
  /** False while the computer sleeps or Work shuts down. */
  private active = true;
  constructor(
    private readonly profiles: ProfileConfigManager,
    private readonly provider: SandboxProvider,
  ) {}
  async connect(args: {
    projectId: string;
    environment: string;
  }): Promise<{ id: string }> {
    const store = this.profiles.forProject(args.projectId).remoteProjects;
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
        return fetch(request, { signal: AbortSignal.timeout(30000) });
      },
    });
    let runner = this.runners.get(args.projectId);
    if (!runner) {
      let failed = false;
      const started: Promise<ReturnType<typeof startClientRunner>> =
        (async () => {
          const registration = await client.POST(
            "/api/projects/{projectId}/client-runners",
            {
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
              },
            },
          );
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
            transport: {
              renew: async () => {
                const response = await client.POST(
                  "/api/client-runners/renew",
                  {
                    body: lease,
                  },
                );
                if (!response.data)
                  throw new Error("Local execution authorization expired");
              },
              poll: async () => {
                const response = await client.POST("/api/client-runners/poll", {
                  body: lease,
                });
                if (response.error) throw new Error(response.error.error);
                return response.data ?? null;
              },
              complete: async (input) => {
                const response = await client.POST(
                  "/api/client-runners/complete",
                  {
                    body: {
                      ...lease,
                      jobId: input.jobId,
                      ...(input.error
                        ? { error: input.error }
                        : {
                            response: ClientRunnerResultSchema.parse(
                              input.response ?? null,
                            ),
                          }),
                    },
                  },
                );
                if (!response.data)
                  throw new Error(
                    "The server did not accept the execution receipt",
                  );
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
              if (this.runners.get(args.projectId) === started)
                this.runners.delete(args.projectId);
              console.warn("[desktop] Local runner stopped", error);
              // A server restart or a network drop ends the connection;
              // this machine keeps serving once the server answers again.
              this.reconnect(args, 1);
            },
          });
        })();
      runner = started;
      this.runners.set(args.projectId, started);
      void started.catch(() => {
        if (this.runners.get(args.projectId) === started)
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
    for (const [projectId, environment] of this.wanted)
      if (!this.runners.has(projectId))
        this.reconnect({ projectId, environment }, 1);
  }

  /** On sleep or shutdown; `resume` serves the same projects again. */
  async stop() {
    this.active = false;
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    await Promise.allSettled(
      [...this.runners.values()].map(async (runner) => (await runner).stop()),
    );
    this.runners.clear();
  }
}
