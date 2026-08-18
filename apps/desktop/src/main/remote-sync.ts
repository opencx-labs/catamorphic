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

/** The documents client plus the two members' verbs beside it. */
export interface RemoteProjectClient extends RemoteDocumentsClient {
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

/** An HTTP client for a hosting backend's documents routes. */
export function httpDocumentsClient(args: {
  serverUrl: string;
  token: string;
  projectId: string;
  fetch?: typeof fetch;
}): RemoteProjectClient {
  const doFetch = args.fetch ?? fetch;
  const base = `${args.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(args.projectId)}/documents`;
  const headers = { authorization: `Bearer ${args.token}` };
  const q = (params: Record<string, string | number | undefined>) =>
    Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(
        ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
      )
      .join("&");
  const fail = async (response: Response, what: string): Promise<never> => {
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
    async list() {
      const response = await doFetch(base, { headers });
      if (!response.ok) return fail(response, "Listing documents");
      return (await response.json()) as RemoteDocumentEntry[];
    },
    async readBytes(relative, version) {
      const response = await doFetch(
        `${base}/raw?${q({ path: relative, version })}`,
        {
          headers,
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
      const response = await doFetch(`${base}/content`, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
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
      const response = await doFetch(
        `${base}/content?${q({ path: input.path, ifVersion: input.ifVersion })}`,
        { method: "DELETE", headers },
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
    async publish(input) {
      const response = await doFetch(
        `${args.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(args.projectId)}/publications`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      if (!response.ok) return fail(response, `Publishing ${input.path}`);
      return (await response.json()) as RemotePublication;
    },
    async propose(input) {
      const response = await doFetch(
        `${args.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(args.projectId)}/proposals`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      if (!response.ok) return fail(response, "Proposing changes");
      return (await response.json()) as RemoteProposalResult;
    },
    async history(relative) {
      const response = await doFetch(
        `${base}/history?${q({ path: relative })}`,
        {
          headers,
        },
      );
      if (!response.ok) return fail(response, `History of ${relative}`);
      return (await response.json()) as RemoteDocumentVersion[];
    },
  };
}
