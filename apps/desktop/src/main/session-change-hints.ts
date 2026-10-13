import type { WorkWakeups } from "@catamorphic/core";

/** How long a hint waits for more changes before it goes out. */
const QUIET_MS = 250;
/** The longest a burst of changes (a busy turn's steps) holds a hint back. */
const MAX_WAIT_MS = 1_500;

/**
 * The API routes that change what chat lists, attention and watchers show:
 * creating, changing, closing, archiving or forking a chat, its attention,
 * its watchers. Core hints these changes itself; a request on one of them
 * hints as well, whoever made it. Other project requests (an app's
 * workflow calls and storage, a terminal's input, MCP) never do.
 */
const CHAT_LIST_ROUTES = new Set(
  [
    "chats/:key",
    "sessions",
    "sessions/:sessionId",
    "sessions/:sessionId/activity",
    "sessions/:sessionId/archive",
    "sessions/:sessionId/attention",
    "sessions/:sessionId/attention/acknowledge",
    "sessions/:sessionId/fork",
    "sessions/:sessionId/metadata",
    "sessions/:sessionId/subsessions",
    "sessions/:sessionId/unarchive",
    "sessions/:sessionId/watchers",
    "sessions/:sessionId/watchers/:watcherId",
  ].map((route) => `/api/projects/:projectId/agent/${route}`),
);

/** Whether a request this server served may have changed its chat lists. */
export function changesChatLists(request: {
  method: string;
  /** The matched route's pattern (Fastify's `routeOptions.url`). */
  route: string | undefined;
}): boolean {
  return (
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    request.route !== undefined &&
    CHAT_LIST_ROUTES.has(request.route)
  );
}

/**
 * Tells the app's windows when its chats may have changed, so their chat
 * lists, attention and watchers read again then rather than on a short
 * poll (ADR 0228): whenever core hints `chats` (a session event lists
 * show, a chat's visibility, attention or watchers), and whenever this
 * server serves a request on a route that changes them (`hint`). A burst
 * of changes goes out as one hint: after `quietMs` without another, or
 * `maxWaitMs` after the first.
 */
export function startSessionChangeHints(input: {
  wakeups: Pick<WorkWakeups, "subscribe">;
  send: () => void;
  quietMs?: number;
  maxWaitMs?: number;
}): { hint: () => void; dispose: () => void } {
  const quietMs = input.quietMs ?? QUIET_MS;
  const maxWaitMs = input.maxWaitMs ?? MAX_WAIT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstAt: number | undefined;
  const flush = () => {
    timer = undefined;
    firstAt = undefined;
    input.send();
  };
  const hint = () => {
    const now = Date.now();
    firstAt ??= now;
    clearTimeout(timer);
    timer = setTimeout(
      flush,
      Math.max(0, Math.min(quietMs, firstAt + maxWaitMs - now)),
    );
  };
  const unsubscribe = input.wakeups.subscribe("chats", hint);
  return {
    hint,
    dispose: () => {
      unsubscribe();
      clearTimeout(timer);
      timer = undefined;
      firstAt = undefined;
    },
  };
}
