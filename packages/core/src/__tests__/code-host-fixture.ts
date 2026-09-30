import { spawn } from "node:child_process";
import http from "node:http";
import type { DB } from "@catamorphic/db";
import type { ProjectManager } from "@catamorphic/git";
import type { Kysely } from "kysely";
import { vi } from "vitest";
import type { Identity } from "../identity.js";
import type { CodeHost } from "../services/code-host.js";
import { CodeHostsService } from "../services/code-hosts-service.js";
import {
  type ConnectionProvider,
  ConnectionProviderRegistry,
} from "../services/connection-providers.js";
import { ConnectionsService } from "../services/connections-service.js";
import { MemoryCredentialVault } from "../services/credential-vault.js";
import { ProjectsService } from "../services/projects-service.js";

const decode = (material: Uint8Array) => new TextDecoder().decode(material);

/**
 * Serve the bare repositories under `root` over Git smart HTTP with
 * `git http-backend`, for code paths that speak HTTP only (isomorphic-git).
 */
export async function gitHttpServer(root: string): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method ?? "GET",
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        // A named user enables receive-pack.
        REMOTE_USER: "test",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    request.pipe(child.stdin);
    let head = Buffer.alloc(0);
    let headersSent = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (headersSent) {
        response.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      let status = 200;
      for (const line of head.subarray(0, end).toString().split("\r\n")) {
        const [name, ...rest] = line.split(":");
        const value = rest.join(":").trim();
        if (!name) continue;
        if (name.toLowerCase() === "status")
          status = Number(value.split(" ")[0]);
        else response.setHeader(name, value);
      }
      response.statusCode = status;
      headersSent = true;
      response.write(head.subarray(end + 4));
    });
    child.on("close", () => response.end());
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Git server has no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * A fake connection provider serving Git for `remoteBase`, and a code host
 * over it (ADR 0177). A connection's material is its token; Git credentials
 * and pull requests record which token acted, so tests can tell a member's
 * connection from the organization's.
 */
export function fakeForge(args: { remoteBase: string }) {
  const gitCalls: Array<{ token: string; access: string; remoteUrl: string }> =
    [];
  const provider: ConnectionProvider = {
    kind: "forge",
    displayName: "Forge",
    beginAuthorization: async () => ({
      challenge: {
        kind: "form",
        fields: [
          { name: "token", label: "Token", secret: true, required: true },
        ],
      },
    }),
    completeAuthorization: async ({ callback }) => ({
      material: new TextEncoder().encode(callback.token ?? ""),
      account: { login: callback.token ?? "someone" },
    }),
    invoke: async () => null,
    git: {
      remoteBaseUrls: [args.remoteBase],
      credentials: async ({ material, remoteUrl, access }) => {
        gitCalls.push({ token: decode(material), access, remoteUrl });
        return { username: "x-access-token", password: decode(material) };
      },
    },
  };
  const createPullRequest = vi.fn(
    async (input: {
      credential: { material: Uint8Array };
      head: string;
      base: string;
      title: string;
    }) => ({
      url: `https://forge.test/pr/${decode(input.credential.material)}`,
      number: 1,
    }),
  );
  const host: CodeHost = {
    provider: "forge",
    createPullRequest,
    listPullRequests: vi.fn(async () => []),
    commentOnPullRequest: async ({ credential, body }) => ({
      id: 1,
      body,
      author: { login: decode(credential.material) },
      createdAt: new Date(0).toISOString(),
      url: "https://forge.test/pr/1#comment-1",
    }),
    viewer: async ({ credential }) => ({ login: decode(credential.material) }),
  };
  return { provider, host, createPullRequest, gitCalls };
}

/** Authorize the organization's `forge` service connection as an administrator. */
export async function connectForgeService(args: {
  connections: ConnectionsService;
  admin: Identity;
  token: string;
  projectId?: string;
}) {
  const created = await args.connections.createService({
    identity: args.admin,
    name: "forge",
    providerKind: "forge",
    principalKind: args.projectId ? "project_service" : "tenant_service",
    ...(args.projectId ? { projectId: args.projectId } : {}),
  });
  const started = await args.connections.beginServiceAuthorization({
    identity: args.admin,
    connectionId: created.id,
    redirectUri: "https://work.test/callback",
  });
  return args.connections.completeAuthorization({
    identity: args.admin,
    state: started.authorizationId,
    callback: { token: args.token },
  });
}

/** {@link fakeForge} wired into a standalone `CodeHostsService`. */
export function fakeCodeHost(args: {
  db: Kysely<DB>;
  projectManager: ProjectManager;
  remoteBase: string;
  /** Shared by the replicas of one test; each gets its own by default. */
  vault?: MemoryCredentialVault;
}) {
  const forge = fakeForge(args);
  const providers = new ConnectionProviderRegistry([forge.provider]);
  const connections = new ConnectionsService({
    db: args.db,
    vault: args.vault ?? new MemoryCredentialVault(),
    providers,
    bindings: async () => ({}),
  });
  const codeHosts = new CodeHostsService({
    db: args.db,
    projectManager: args.projectManager,
    projects: new ProjectsService(args.db, args.projectManager),
    hosts: [forge.host],
    providers,
    connections,
  });
  return {
    ...forge,
    connections,
    codeHosts,
    /** The member's own connection, not tied to a project. */
    connectPersonal: (identity: Identity, token: string) =>
      connections.savePersonal({
        identity,
        providerKind: "forge",
        authorized: {
          material: new TextEncoder().encode(token),
          account: { login: token },
        },
      }),
    connectService: (admin: Identity, token: string, projectId?: string) =>
      connectForgeService({
        connections,
        admin,
        token,
        ...(projectId ? { projectId } : {}),
      }),
  };
}
