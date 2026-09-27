import type { FetchLike, GithubJson } from "./types.js";

const API_BASE = "https://api.github.com";
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export type GithubRestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface GithubRestRequest {
  /** Installation or user access token. */
  token: string;
  method: GithubRestMethod;
  /** Path below the API base, e.g. `/repos/octo/hello/pulls`. */
  path: string;
  query?: Readonly<Record<string, string>>;
  body?: unknown;
  /**
   * A GitHub media type, e.g. `application/vnd.github.diff`. Default
   * `application/vnd.github+json`.
   */
  accept?: string;
  /** Byte offset into the response body, to read large bodies in ranges. */
  offset?: number;
  /** Largest slice of the body returned. Default 1 MiB. */
  maxResponseBytes?: number;
  /** REST API base; GitHub Enterprise Server uses `https://HOST/api/v3`. */
  apiBaseUrl?: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

export interface GithubRestResponse {
  status: number;
  contentType: string;
  /** Parsed JSON when the whole body was returned; text otherwise. */
  body: GithubJson;
  location?: string;
  /** Set when the body did not fit: read on from `nextOffset`. */
  truncated?: true;
  nextOffset?: number;
  totalBytes: number;
}

/**
 * One GitHub REST call on behalf of a brokered connection. The path must stay
 * below the API base (no `..`, encoded separators, or query in the path),
 * redirects are returned instead of followed so the token never travels
 * elsewhere, and large bodies are returned in byte ranges.
 */
export async function githubRestRequest(
  request: GithubRestRequest,
): Promise<GithubRestResponse> {
  const target = githubRestUrl({
    path: request.path,
    query: request.query,
    apiBaseUrl: request.apiBaseUrl,
  });
  const accept = request.accept ?? "application/vnd.github+json";
  if (!/^application\/(vnd\.github[\w.+-]*|json)$/.test(accept)) {
    throw new Error(`Unsupported media type '${accept}'`);
  }
  const offset = request.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("offset must be a non-negative integer");
  }
  const hasBody = request.body !== undefined && request.method !== "GET";
  const response = await (request.fetch ?? fetch)(target, {
    method: request.method,
    headers: {
      Accept: accept,
      Authorization: `Bearer ${request.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    },
    redirect: "manual",
    ...(request.signal ? { signal: request.signal } : {}),
    ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const maxBytes = request.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const end = utf8Boundary({
    bytes,
    start: offset,
    end: Math.min(bytes.byteLength, offset + maxBytes),
  });
  const whole = offset === 0 && end === bytes.byteLength;
  const text = new TextDecoder().decode(bytes.slice(offset, end));
  const contentType = response.headers.get("content-type") ?? "";
  const location = response.headers.get("location");
  return {
    status: response.status,
    contentType,
    body: whole && contentType.includes("json") ? parseJson(text) : text,
    ...(location ? { location } : {}),
    ...(end < bytes.byteLength
      ? { truncated: true as const, nextOffset: end }
      : {}),
    totalBytes: bytes.byteLength,
  };
}

/** Resolve a caller path against the API base, refusing anything outside it. */
export function githubRestUrl(args: {
  path: string;
  query?: Readonly<Record<string, string>>;
  apiBaseUrl?: string;
}): string {
  const base = new URL(args.apiBaseUrl ?? API_BASE);
  const basePath = base.pathname.replace(/\/+$/, "");
  const path = args.path.startsWith("/") ? args.path : `/${args.path}`;
  if (
    path.includes("..") ||
    path.includes("\\") ||
    path.includes("//") ||
    /[?#]/.test(path) ||
    /%(2e|2f|5c)/i.test(path)
  ) {
    throw new Error(
      "Paths may not contain '..', '//', '?', '#', backslashes, or encoded dots and slashes",
    );
  }
  const target = new URL(`${basePath}${path}`, base.origin);
  if (
    target.origin !== base.origin ||
    (basePath &&
      target.pathname !== basePath &&
      !target.pathname.startsWith(`${basePath}/`))
  ) {
    throw new Error("Requests must stay on the GitHub API");
  }
  for (const [key, value] of Object.entries(args.query ?? {})) {
    target.searchParams.set(key, value);
  }
  return target.toString();
}

/**
 * The repository a REST path addresses (`/repos/{owner}/{repo}/...`), so a
 * minted token can be narrowed to it. Null for paths outside one repository.
 */
export function repositoryFromRestPath(
  path: string,
): { owner: string; name: string } | null {
  const match = /^\/?repos\/([\w.-]+)\/([\w.-]+)(?:\/|$)/.exec(path);
  if (!match?.[1] || !match[2]) return null;
  return { owner: match[1], name: match[2] };
}

/** Move a range end back so a slice never splits a UTF-8 character. */
function utf8Boundary(args: {
  bytes: Uint8Array;
  start: number;
  end: number;
}): number {
  if (args.end >= args.bytes.byteLength) return args.end;
  for (let end = args.end; end > args.start; end--) {
    // Continuation bytes look like 0b10xxxxxx.
    if (((args.bytes[end] ?? 0) & 0xc0) !== 0x80) return end;
  }
  return args.end;
}

function parseJson(text: string): GithubJson {
  try {
    const parsed: GithubJson = JSON.parse(text);
    return parsed;
  } catch {
    return text;
  }
}
