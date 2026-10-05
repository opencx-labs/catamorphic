import { createApiClient, type paths } from "@catamorphic/api-client";
import type {
  PersonalEnvironmentInput,
  PersonalEnvironmentStatus,
  PullRequestComment,
  PullRequestDiscussion,
  PullRequestFile,
  PullRequestSummary,
  RemoteDocumentEntry,
  RemoteDocumentsClient,
  RemoteDocumentVersion,
} from "@catamorphic/core";
import { syncRemoteProject } from "@catamorphic/core";

export {
  type LocalStatus,
  localStatus,
  MANIFEST_PATH,
  type RemoteDocumentEntry,
  type RemoteDocumentsClient,
  type RemoteDocumentVersion,
  type ShipReport,
  STORE_PREFIX,
  type SyncReport,
  serverCopyPath,
  shipRemoteProject,
  syncRemoteProject,
} from "@catamorphic/core";

export interface RemotePublication {
  slug: string;
  path: string;
  audience: "public" | "members";
  /** Path relative to the server's API base. */
  url: string;
}

export interface RemoteProposalResult {
  branch: string;
  pullRequest?: { url: string; number: number };
}

export interface RemoteRole {
  slug: string;
  definition?: { name: string };
}

export interface RemoteMember {
  externalUserId: string;
  name: string | null;
  email: string | null;
  roles: string[];
}

export interface RemoteInvitation {
  id: string;
  expiresAt: string;
  connectLinks: string[];
  webLinks: string[];
}

export interface RemoteAccessRequest {
  id: string;
  externalUserId: string;
  email: string;
  emailVerified: boolean;
  status: string;
  requestedAt: string;
}

/** A connection provider the server offers (`GET /connection-providers`). */
export interface RemoteConnectionProvider {
  kind: string;
  displayName: string;
}

/** A named service connection on the server (ADR 0172). */
export interface RemoteServiceConnection {
  id: string;
  projectId: string | null;
  providerKind: string;
  principalKind: "tenant_service" | "project_service" | "member";
  name: string | null;
  ownerExternalUserId: string | null;
  label: string;
  status: "pending" | "ready" | "expired" | "revoked";
  account: unknown;
  scopes: string[];
  capabilities: string[];
  expiresAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** What a provider asks for to authorize a connection. */
export type RemoteAuthorizationChallenge =
  | {
      kind: "form";
      fields: Array<{
        name: string;
        label: string;
        secret: boolean;
        required: boolean;
        multiline?: boolean;
      }>;
    }
  | { kind: "url"; url: string; expiresAt?: string }
  | {
      kind: "device";
      verificationUrl: string;
      userCode: string;
      expiresAt?: string;
    };

export interface RemoteServiceAuthorization {
  authorizationId: string;
  challenge: RemoteAuthorizationChallenge;
}

/** `GET /me` on the host (ADR 0055). */
export interface RemoteMe {
  version: number;
  identity: {
    externalUserId: string;
    root: boolean;
    /** Organization-wide grants; absent on older servers. */
    controlPlanePermissions?: string[];
  };
  projects: Array<{
    projectId: string;
    name: string;
    source: { remoteUrl: string; defaultBranch: string } | null;
    permissions: string[];
    agents: string[];
    workflows: string[];
    apps: string[];
    documents: Array<{ path: string; access: "read" | "write" }>;
    /** Absent on hosts older than ADR 0152. */
    roles?: Array<{ name: string; description?: string }>;
  }>;
  features: {
    publications: "public" | "members" | false;
    proposals: boolean;
    proposalsOpenPullRequests: boolean;
    mcp: boolean;
    agentSessions: boolean;
    storeUploadMaxBytes: number;
  };
}

type DeployRoute = paths["/api/projects/{projectId}/deploy"];
type DeployBody = NonNullable<
  DeployRoute["post"]["requestBody"]
>["content"]["application/json"];
type DeployResult =
  DeployRoute["post"]["responses"][200]["content"]["application/json"];
/**
 * `PUT /projects/:projectId/personal-environment` (ADR 0184): replaces the
 * caller's own files for the project, contents as base64, and their own
 * setup command (ADR 0207). Sign-ins are never sent (ADR 0199).
 */
export type RemotePersonalEnvironmentUpload = PersonalEnvironmentInput;

/** `GET /projects/:projectId/personal-environment`: never any file contents. */
export type RemotePersonalEnvironment = PersonalEnvironmentStatus;

/** Reads the status defensively: sync decisions depend on it. */
export function parseRemotePersonalEnvironment(
  value: unknown,
): RemotePersonalEnvironment {
  const object = (item: unknown): Record<string, unknown> | null =>
    typeof item === "object" && item !== null && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item))
      : null;
  const body = object(value);
  if (!body || typeof body.allowed !== "boolean")
    throw new Error("The server sent an unreadable remote environment");
  const files = (Array.isArray(body.files) ? body.files : []).flatMap(
    (item) => {
      const entry = object(item);
      if (!entry || typeof entry.path !== "string") return [];
      return [
        {
          path: entry.path,
          fingerprint:
            typeof entry.fingerprint === "string" ? entry.fingerprint : "",
          bytes: typeof entry.bytes === "number" ? entry.bytes : 0,
          updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
        },
      ];
    },
  );
  const setup = object(body.setup);
  return {
    allowed: body.allowed,
    files,
    setup:
      setup && typeof setup.command === "string"
        ? {
            command: setup.command,
            updatedAt:
              typeof setup.updatedAt === "string" ? setup.updatedAt : "",
          }
        : null,
  };
}

/** A 401 from the host: the token no longer works. */
export class RemoteAuthError extends Error {
  constructor(what: string) {
    super(`${what}: your access to this server has expired or was revoked`);
    this.name = "RemoteAuthError";
  }
}

/** The documents client plus the two members' verbs beside it. */
export interface RemoteProjectClient extends RemoteDocumentsClient {
  proposalReview(
    number: number,
  ): Promise<{ proposal: PullRequestSummary; files: PullRequestFile[] }>;
  listProposals(): Promise<PullRequestSummary[]>;
  proposalFiles(number: number): Promise<PullRequestFile[]>;
  proposalDiscussion(number: number): Promise<PullRequestDiscussion>;
  proposalComment(input: {
    number: number;
    body: string;
    replyTo?: number;
  }): Promise<PullRequestComment>;
  me(): Promise<RemoteMe>;
  admit(input: { invitationId?: string }): Promise<void>;
  listRoles(): Promise<RemoteRole[]>;
  listMembers(): Promise<RemoteMember[]>;
  listAccessRequests(): Promise<RemoteAccessRequest[]>;
  decideAccessRequest(
    requestId: string,
    decision: "approved" | "denied",
  ): Promise<void>;
  setMemberRoles(externalUserId: string, roles: string[]): Promise<void>;
  inviteMember(input: {
    email?: string;
    roles: string[];
  }): Promise<RemoteInvitation>;
  listConnectionProviders(): Promise<RemoteConnectionProvider[]>;
  listServiceConnections(): Promise<RemoteServiceConnection[]>;
  createServiceConnection(input: {
    name: string;
    providerKind: string;
  }): Promise<RemoteServiceConnection>;
  authorizeServiceConnection(
    connectionId: string,
  ): Promise<RemoteServiceAuthorization>;
  completeConnectionAuthorization(input: {
    authorizationId: string;
    callback: Record<string, string>;
  }): Promise<RemoteServiceConnection>;
  revokeConnection(connectionId: string): Promise<void>;
  /** The member's remote environment, or null on a server without it. */
  personalEnvironment(): Promise<RemotePersonalEnvironment | null>;
  putPersonalEnvironment(input: RemotePersonalEnvironmentUpload): Promise<void>;
  deletePersonalEnvironment(): Promise<void>;
  publish(input: {
    path: string;
    audience: "public" | "members";
  }): Promise<RemotePublication>;
  propose(input: {
    title: string;
    body?: string;
    changes: Array<{ path: string; content?: string; delete?: boolean }>;
  }): Promise<RemoteProposalResult>;
  /** Deploy program files directly; the member must hold `program:publish`. */
  publishProgram(input: DeployBody): Promise<DeployResult>;
}

/**
 * Publish a member's program edits from their folder (ADR 0191). The folder
 * downloads first, so a file someone else published since its last sync is
 * reconciled here and never overwritten; the publish then names the commit
 * that download read as its base, so a change landing in between comes back
 * as a conflict instead of being overwritten.
 */
export async function publishProgramFromFolder(input: {
  root: string;
  client: RemoteDocumentsClient & Pick<RemoteProjectClient, "publishProgram">;
  message: string;
  paths: readonly string[];
  /** The selected files' contents, read after the download. */
  readChanges: () => Array<{ path: string; content: string }>;
}): Promise<DeployResult> {
  const report = await syncRemoteProject(input.root, input.client);
  const changedThere = report.conflicts
    .map((conflict) => conflict.path)
    .filter((conflicted) => input.paths.includes(conflicted));
  if (changedThere.length > 0)
    throw new Error(
      `${changedThere.join(", ")} changed on the server since your last download. Compare your version with the server copy beside it, then publish again.`,
    );
  return input.client.publishProgram({
    message: input.message,
    files: Object.fromEntries(
      input.readChanges().map((change) => [change.path, change.content]),
    ),
    ...(report.programCommit ? { base: report.programCommit } : {}),
  });
}

/** Builder clones own program files; remote sync may only materialize store. */
export function storeOnlyDocumentsClient(
  client: RemoteProjectClient,
): RemoteDocumentsClient {
  return {
    ...client,
    sources: ["store"],
    list: async () =>
      (await client.list()).filter((entry) => entry.source === "store"),
  };
}

/** Sign-in identifies the user; admission separately grants project access. */
export async function ensureRemoteProjectAccess(options: {
  client: RemoteProjectClient;
  projectId: string;
  invitationId?: string;
}): Promise<void> {
  const before = await options.client.me();
  if (
    before.projects.some((project) => project.projectId === options.projectId)
  ) {
    return;
  }
  await options.client.admit({
    ...(options.invitationId ? { invitationId: options.invitationId } : {}),
  });
  const after = await options.client.me();
  if (
    !after.projects.some((project) => project.projectId === options.projectId)
  ) {
    throw new Error(
      "You signed in, but you do not have access to this project yet.",
    );
  }
}

/** An HTTP client for a hosting backend's documents routes. */
export function httpDocumentsClient(args: {
  serverUrl: string;
  accessToken(forceRefresh?: boolean): Promise<string>;
  projectId: string;
  fetch?: typeof fetch;
}): RemoteProjectClient {
  const doFetch = args.fetch ?? fetch;
  const base = `${args.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(args.projectId)}/documents`;
  const personalEnvironmentUrl = `${args.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(args.projectId)}/personal-environment`;
  const authorizedFetch = async (url: string, init: RequestInit = {}) => {
    const request = async (forceRefresh: boolean) =>
      doFetch(url, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers).entries()),
          authorization: `Bearer ${await args.accessToken(forceRefresh)}`,
        },
      });
    const response = await request(false);
    return response.status === 401 ? request(true) : response;
  };
  const proposalClient = createApiClient({
    baseUrl: args.serverUrl.replace(/\/api\/?$/, ""),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      return authorizedFetch(request.url, {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        ...(request.method === "GET" || request.method === "HEAD"
          ? {}
          : { body: await request.text() }),
      });
    },
  });
  const q = (params: Record<string, string | number | undefined>) =>
    Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(
        ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
      )
      .join("&");
  const fail = async (response: Response, what: string): Promise<never> => {
    if (response.status === 401) throw new RemoteAuthError(what);
    let detail = "";
    try {
      detail = ((await response.json()) as { error?: string }).error ?? "";
    } catch {
      // no body
    }
    throw new Error(
      `${what} failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  };
  return {
    async admit(input) {
      const admissionPath = input.invitationId
        ? `/admission/invitations/${encodeURIComponent(input.invitationId)}/redeem`
        : "/admission/join";
      const response = await authorizedFetch(
        `${args.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(args.projectId)}${admissionPath}`,
        { method: "POST" },
      );
      if (!response.ok) return fail(response, "Joining project");
    },
    async listRoles() {
      const response = await authorizedFetch(
        `${args.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(args.projectId)}/roles`,
      );
      if (!response.ok) return fail(response, "Listing project roles");
      return (await response.json()) as RemoteRole[];
    },
    async listMembers() {
      const response = await authorizedFetch(
        `${args.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(args.projectId)}/admission/members`,
      );
      if (!response.ok) return fail(response, "Listing project members");
      return (await response.json()) as RemoteMember[];
    },
    async listAccessRequests() {
      const response = await authorizedFetch(
        `${args.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(args.projectId)}/admission/requests`,
      );
      if (!response.ok) return fail(response, "Listing access requests");
      return (await response.json()) as RemoteAccessRequest[];
    },
    async decideAccessRequest(requestId, decision) {
      const response = await authorizedFetch(
        `${args.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(args.projectId)}/admission/requests/${encodeURIComponent(requestId)}/decision`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision }),
        },
      );
      if (!response.ok) return fail(response, "Deciding access request");
    },
    async setMemberRoles(externalUserId, roles) {
      const response = await authorizedFetch(
        `${args.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(args.projectId)}/memberships/${encodeURIComponent(externalUserId)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ roles }),
        },
      );
      if (!response.ok) return fail(response, "Updating project member");
    },
    async inviteMember(input) {
      const response = await authorizedFetch(
        `${args.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(args.projectId)}/admission/invitations`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      if (!response.ok) return fail(response, "Inviting project member");
      return (await response.json()) as RemoteInvitation;
    },
    async listConnectionProviders() {
      const response = await authorizedFetch(
        `${args.serverUrl.replace(/\/+$/, "")}/connection-providers`,
      );
      if (!response.ok) return fail(response, "Listing connection providers");
      return (await response.json()) as RemoteConnectionProvider[];
    },
    async listServiceConnections() {
      const response = await authorizedFetch(
        `${args.serverUrl.replace(/\/+$/, "")}/service-connections`,
      );
      if (!response.ok) return fail(response, "Listing service connections");
      return (await response.json()) as RemoteServiceConnection[];
    },
    async createServiceConnection(input) {
      const response = await authorizedFetch(
        `${args.serverUrl.replace(/\/+$/, "")}/service-connections`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: input.name,
            providerKind: input.providerKind,
            principalKind: "tenant_service",
          }),
        },
      );
      if (!response.ok) return fail(response, "Adding the connection");
      return (await response.json()) as RemoteServiceConnection;
    },
    async authorizeServiceConnection(connectionId) {
      const response = await authorizedFetch(
        `${args.serverUrl.replace(/\/+$/, "")}/service-connections/${encodeURIComponent(connectionId)}/authorize`,
        { method: "POST" },
      );
      if (!response.ok) return fail(response, "Connecting");
      return (await response.json()) as RemoteServiceAuthorization;
    },
    async completeConnectionAuthorization(input) {
      const response = await authorizedFetch(
        `${args.serverUrl.replace(/\/+$/, "")}/connection-authorizations/complete`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            state: input.authorizationId,
            callback: input.callback,
          }),
        },
      );
      if (!response.ok) return fail(response, "Connecting");
      return (await response.json()) as RemoteServiceConnection;
    },
    async revokeConnection(connectionId) {
      const response = await authorizedFetch(
        `${args.serverUrl.replace(/\/+$/, "")}/connections/${encodeURIComponent(connectionId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) return fail(response, "Revoking the connection");
    },
    async personalEnvironment() {
      const response = await authorizedFetch(personalEnvironmentUrl);
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok)
        return fail(response, "Reading your remote environment");
      return parseRemotePersonalEnvironment(await response.json());
    },
    async putPersonalEnvironment(input) {
      const response = await authorizedFetch(personalEnvironmentUrl, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok)
        return fail(response, "Sending your remote environment");
      await response.body?.cancel();
    },
    async deletePersonalEnvironment() {
      const response = await authorizedFetch(personalEnvironmentUrl, {
        method: "DELETE",
      });
      if (!response.ok && response.status !== 404)
        return fail(response, "Removing your remote environment");
      await response.body?.cancel();
    },
    async list() {
      const response = await authorizedFetch(base);
      if (!response.ok) return fail(response, "Listing documents");
      return (await response.json()) as RemoteDocumentEntry[];
    },
    async readBytes(relative, version) {
      const response = await authorizedFetch(
        `${base}/raw?${q({ path: relative, version })}`,
        {
          headers: {},
        },
      );
      if (!response.ok) return fail(response, `Reading ${relative}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const versionHeader = response.headers.get(
        "x-catamorphic-document-version",
      );
      const source = response.headers.get("x-catamorphic-document-source");
      return {
        bytes,
        entry: {
          path: relative,
          source: source === "store" ? "store" : "program",
          contentType:
            response.headers.get("content-type") ?? "application/octet-stream",
          size: bytes.byteLength,
          ...(versionHeader ? { version: Number(versionHeader) } : {}),
        },
      };
    },
    async write(input) {
      const response = await authorizedFetch(`${base}/content`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: input.path,
          base64: Buffer.from(input.bytes).toString("base64"),
          ...(input.contentType ? { contentType: input.contentType } : {}),
          ...(input.ifVersion !== undefined
            ? { ifVersion: input.ifVersion }
            : {}),
        }),
      });
      if (response.status === 409) {
        const body = (await response.json()) as { currentVersion: number };
        return {
          ok: false,
          conflict: true,
          currentVersion: body.currentVersion,
        };
      }
      if (!response.ok) return fail(response, `Writing ${input.path}`);
      return {
        ok: true,
        entry: (await response.json()) as RemoteDocumentEntry,
      };
    },
    async delete(input) {
      const response = await authorizedFetch(
        `${base}/content?${q({ path: input.path, ifVersion: input.ifVersion })}`,
        { method: "DELETE" },
      );
      if (response.status === 409) {
        const body = (await response.json()) as { currentVersion: number };
        return {
          ok: false,
          conflict: true,
          currentVersion: body.currentVersion,
        };
      }
      if (response.status === 404) return { ok: false, notFound: true };
      if (!response.ok) return fail(response, `Deleting ${input.path}`);
      return {
        ok: true,
        version: ((await response.json()) as { version: number }).version,
      };
    },
    async me() {
      const response = await authorizedFetch(
        `${args.serverUrl.replace(/\/+$/, "")}/me`,
        {
          headers: {},
        },
      );
      if (!response.ok) return fail(response, "Reading your access");
      const body = (await response.json()) as RemoteMe;
      if (body.version !== 1) {
        throw new Error("Reading your access returned an unsupported version");
      }
      return body;
    },
    async publish(input) {
      const response = await authorizedFetch(
        `${args.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(args.projectId)}/publications`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      if (!response.ok) return fail(response, `Publishing ${input.path}`);
      return (await response.json()) as RemotePublication;
    },
    async propose(input) {
      const response = await authorizedFetch(
        `${args.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(args.projectId)}/proposals`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      if (!response.ok) return fail(response, "Proposing changes");
      return (await response.json()) as RemoteProposalResult;
    },
    async publishProgram(input) {
      const { data, response } = await proposalClient.POST(
        "/api/projects/{projectId}/deploy",
        {
          params: { path: { projectId: args.projectId } },
          body: input,
        },
      );
      if (!data) return fail(response, "Publishing project files");
      return data;
    },
    async proposalReview(number) {
      const { data, response } = await proposalClient.GET(
        "/api/projects/{projectId}/proposals/{number}",
        { params: { path: { projectId: args.projectId, number } } },
      );
      if (!data) return fail(response, "Reading proposal");
      return data;
    },
    async listProposals() {
      const { data, response } = await proposalClient.GET(
        "/api/projects/{projectId}/proposals",
        { params: { path: { projectId: args.projectId } } },
      );
      if (!data) return fail(response, "Reading proposals");
      return data;
    },
    async proposalDiscussion(number) {
      const { data, response } = await proposalClient.GET(
        "/api/projects/{projectId}/proposals/{number}/discussion",
        { params: { path: { projectId: args.projectId, number } } },
      );
      if (!data) return fail(response, "Reading proposal discussion");
      return data;
    },
    async proposalComment(input) {
      const { data, response } = await proposalClient.POST(
        "/api/projects/{projectId}/proposals/{number}/comments",
        {
          params: { path: { projectId: args.projectId, number: input.number } },
          body: { body: input.body, replyTo: input.replyTo },
        },
      );
      if (!data) return fail(response, "Posting proposal comment");
      return data;
    },
    async proposalFiles(number) {
      const { data, response } = await proposalClient.GET(
        "/api/projects/{projectId}/proposals/{number}/files",
        { params: { path: { projectId: args.projectId, number } } },
      );
      if (!data) return fail(response, "Reading proposal files");
      return data;
    },
    async history(relative) {
      const response = await authorizedFetch(
        `${base}/history?${q({ path: relative })}`,
        {
          headers: {},
        },
      );
      if (!response.ok) return fail(response, `History of ${relative}`);
      return (await response.json()) as RemoteDocumentVersion[];
    },
  };
}
