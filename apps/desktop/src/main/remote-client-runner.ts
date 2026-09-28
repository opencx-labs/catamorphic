import { createApiClient } from "@catamorphic/api-client";
import { ClientRunnerResultSchema } from "@catamorphic/core";
import type { SandboxProvider } from "@catamorphic/sandbox";
import { startClientRunner } from "@catamorphic/server-sdk";
import type { ProfileConfigManager } from "./profile-config.js";
import { refreshRemoteCredentials } from "./remote-oauth.js";

/** Per-project authenticated runner, independent of desktop's local root API. */
export class RemoteClientRunners {
  private readonly runners = new Map<
    string,
    Promise<ReturnType<typeof startClientRunner>>
  >();
  /** The Environment each project's member asked this machine to serve. */
  private readonly wanted = new Map<string, string>();
  private readonly retries = new Map<string, NodeJS.Timeout>();
  private stopping = false;
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
      runner = (async () => {
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
        if (!registration.data)
          throw new Error(
            registration.error?.error ?? "Local execution could not connect",
          );
        const lease = registration.data;
        return startClientRunner({
          provider: this.provider,
          transport: {
            renew: async () => {
              const response = await client.POST("/api/client-runners/renew", {
                body: lease,
              });
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
            this.runners.delete(args.projectId);
            console.warn("[desktop] Local runner stopped", error);
            // A server restart or a network drop ends the connection;
            // this machine keeps serving once the server answers again.
            this.reconnect(args, 1);
          },
        });
      })();
      this.runners.set(args.projectId, runner);
      void runner.catch(() => this.runners.delete(args.projectId));
    }
    await runner;
    return { id: link.connectionId };
  }
  private reconnect(
    args: { projectId: string; environment: string },
    attempt: number,
  ) {
    if (
      this.stopping ||
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
        void this.connect(args).catch(() => this.reconnect(args, attempt + 1));
      },
      Math.min(60_000, 2_000 * 2 ** (attempt - 1)),
    );
    timer.unref();
    this.retries.set(args.projectId, timer);
  }

  async stop() {
    this.stopping = true;
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    await Promise.allSettled(
      [...this.runners.values()].map(async (runner) => (await runner).stop()),
    );
    this.runners.clear();
  }
}
