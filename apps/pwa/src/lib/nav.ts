import { useSyncExternalStore } from "react";

/**
 * A tiny history-backed router. Hash paths so the PWA works from any
 * static host, real history entries so the platform back gesture pops the
 * stack the way a native app would. `depth` orders routes for the
 * push/fade screen transition.
 */
export type Route =
  | { kind: "projects" }
  | { kind: "connect" }
  | { kind: "profiles" }
  | { kind: "sessions"; connectionId: string; projectId: string }
  | {
      kind: "chat";
      connectionId: string;
      projectId: string;
      /** null = a fresh chat, created lazily on first send. */
      sessionId: string | null;
    };

export function routeDepth(route: Route): number {
  switch (route.kind) {
    case "projects":
      return 0;
    case "connect":
    case "profiles":
      return 1;
    case "sessions":
      return 1;
    case "chat":
      return 2;
  }
}

export function formatHash(route: Route): string {
  switch (route.kind) {
    case "projects":
      return "#/projects";
    case "connect":
      return "#/connect";
    case "profiles":
      return "#/profiles";
    case "sessions":
      return `#/c/${route.connectionId}/p/${route.projectId}`;
    case "chat":
      return `#/c/${route.connectionId}/p/${route.projectId}/s/${route.sessionId ?? "new"}`;
  }
}

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "connect") return { kind: "connect" };
  if (parts[0] === "profiles") return { kind: "profiles" };
  if (
    parts[0] === "c" &&
    typeof parts[1] === "string" &&
    parts[2] === "p" &&
    typeof parts[3] === "string"
  ) {
    const base = { connectionId: parts[1], projectId: parts[3] };
    if (parts[4] === "s" && typeof parts[5] === "string") {
      return {
        kind: "chat",
        ...base,
        sessionId: parts[5] === "new" ? null : parts[5],
      };
    }
    return { kind: "sessions", ...base };
  }
  return { kind: "projects" };
}

const listeners = new Set<() => void>();
let current: Route = parseHash(window.location.hash);

window.addEventListener("popstate", () => {
  current = parseHash(window.location.hash);
  for (const listener of listeners) listener();
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, () => current);
}

/** The screen behind this one when history has nothing to pop. */
export function parentRoute(route: Route): Route {
  switch (route.kind) {
    case "chat":
      return {
        kind: "sessions",
        connectionId: route.connectionId,
        projectId: route.projectId,
      };
    default:
      return { kind: "projects" };
  }
}

interface NavState {
  pwaDepth?: number;
}

function currentDepth(): number {
  return (history.state as NavState | null)?.pwaDepth ?? 0;
}

export function navigate(route: Route, options?: { replace?: boolean }) {
  const hash = formatHash(route);
  if (options?.replace) {
    history.replaceState({ pwaDepth: currentDepth() }, "", hash);
  } else {
    history.pushState({ pwaDepth: currentDepth() + 1 }, "", hash);
  }
  current = route;
  for (const listener of listeners) listener();
}

/**
 * The header back button: pop real history when this session pushed the
 * entry, else glide to the structural parent — a cold start on a deep URL
 * (or a replace-redeemed first invite) must not dead-end the chevron.
 */
export function goBack() {
  if (currentDepth() > 0) {
    history.back();
  } else {
    navigate(parentRoute(current), { replace: true });
  }
}
