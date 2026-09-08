import type {
  RemoteDocumentEntry,
  RemoteDocumentsClient,
  RemoteDocumentVersion,
} from "@catamorphic/core";

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

/** `GET /me` on the host (ADR 0055). */
export interface RemoteMe {
  version: number;
  identity: { externalUserId: string; root: boolean };
  projects: Array<{
    projectId: string;
    builder: boolean;
    source: { remoteUrl: string; defaultBranch: string } | null;
    permissions: string[];
    agents: string[];
    workflows: string[];
    apps: string[];
    documents: Array<{ path: string; access: "read" | "write" }>;
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

/** A 401 from the host: the token no longer works. */
export class RemoteAuthError extends Error {
  constructor(what: string) {
    super(`${what}: your access to this server has expired or was revoked`);
    this.name = "RemoteAuthError";
  }
}

/** The documents client plus the two members' verbs beside it. */
export interface RemoteProjectClient extends RemoteDocumentsClient {
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
  publish(input: {
    path: string;
    audience: "public" | "members";
  }): Promise<RemotePublication>;
  propose(input: {
    title: string;
    body?: string;
    changes: Array<{ path: string; content?: string; delete?: boolean }>;
  }): Promise<RemoteProposalResult>;
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
