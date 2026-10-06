import { randomBytes, timingSafeEqual } from "node:crypto";

/*
 * Who may reach the desktop's loopback listeners. The embedded API answers
 * every request as the person at this computer, and a remote project's
 * routes reach their server with that person's credentials, terminals
 * included (ADR 0209). Any web page in any browser on this machine can
 * send requests to a loopback port, so the listeners tell their own
 * callers from web pages:
 *
 * - the desktop's own windows carry a token the main process adds to their
 *   requests, which no page can learn;
 * - local programs that are not browsers (agent harnesses, the phone's
 *   proxy, command-line tools) send neither `Origin` nor `Sec-Fetch-Site`
 *   and are trusted as any program the person runs is;
 * - anything else a browser sends is refused.
 *
 * Both also refuse a `Host` other than the address they serve, which a DNS
 * rebinding attack would send.
 */

/** The header the desktop's own windows carry to the embedded API. */
export const DESKTOP_API_TOKEN_HEADER = "x-work-desktop-token";

/** A token for this run of the desktop: unguessable, never stored. */
export function newDesktopApiToken(): string {
  return randomBytes(32).toString("base64url");
}

type Headers = Readonly<Record<string, string | string[] | undefined>>;

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * A browser stamped this request: a page, not a local program. Browsers
 * send `Sec-Fetch-Site` with every request to a trustworthy URL (loopback
 * is one), and `Origin` with every cross-origin one. Node's `fetch`
 * (undici, in this main process, the phone's proxy, or code in a local
 * sandbox) sends `Sec-Fetch-Mode` alone, so that one says nothing.
 */
function fromBrowser(headers: Headers): boolean {
  return (
    header(headers, "origin") !== undefined ||
    header(headers, "sec-fetch-site") !== undefined
  );
}

/** The request names the loopback address it was sent to. */
function loopbackHost(input: { headers: Headers; port: number }): boolean {
  const host = header(input.headers, "host")?.toLowerCase();
  return (
    host === `127.0.0.1:${input.port}` || host === `localhost:${input.port}`
  );
}

function sameToken(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Why the embedded API refuses a request, or undefined when it may pass.
 * A CORS preflight passes: answering it does nothing, and the request it
 * clears still needs the token.
 */
export function localApiRefusal(input: {
  method: string;
  /** The request's path and query. */
  url: string;
  headers: Headers;
  port: number;
  token: string;
}): string | undefined {
  if (!loopbackHost(input))
    return "The desktop's API answers only on its loopback address";
  if (sameToken(input.token, header(input.headers, DESKTOP_API_TOKEN_HEADER)))
    return undefined;
  if (input.method === "OPTIONS") return undefined;
  // A connection's authorization ends in the person's own browser, which
  // lands here; the page only reports the outcome.
  if (
    input.method === "GET" &&
    input.url.startsWith("/api/connection-authorizations/callback?")
  )
    return undefined;
  if (fromBrowser(input.headers))
    return "Web pages cannot use the desktop's API";
  return undefined;
}

/**
 * Why a preview (ADR 0209) refuses a request, or undefined. A preview is
 * served on a loopback host of its own (`http://p-<id>.localhost:<port>`),
 * so its cookies are its alone; it answers only that host. A preview tab
 * loads its own pages and their resources, and a typed address; every
 * request from another site, a plain link included, gets nothing.
 */
export function previewRequestRefusal(input: {
  headers: Headers;
  /** The preview's own origin. */
  origin: string;
}): string | undefined {
  const own = new URL(input.origin);
  if (header(input.headers, "host")?.toLowerCase() !== own.host)
    return "A preview answers only on its own address";
  const origin = header(input.headers, "origin");
  if (origin !== undefined && origin !== own.origin)
    return "Another site cannot use this preview";
  const site = header(input.headers, "sec-fetch-site");
  if (site !== undefined && site !== "same-origin" && site !== "none")
    return "Another site cannot use this preview";
  return undefined;
}
