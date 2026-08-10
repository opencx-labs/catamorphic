"use client";

import {
  APP_PROTOCOL_VERSION,
  type AppCallErrorCode,
  type AppContext,
  type AppHostTheme,
  type GuestToHostMessage,
  type HostToGuestMessage,
  isGuestMessage,
} from "@catamorphic/app";
import { useCatamorphic } from "@catamorphic/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const MIN_HEIGHT_PX = 240;
const MAX_HEIGHT_PX = 2000;
/** Guests are untrusted: bound the payload before it leaves the iframe. */
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_INPUT_DEPTH = 32;
/**
 * In-flight guest-originated requests per mount. Every `call` is a queued run
 * and every `poll-run` is a host-authenticated API request, so a misbehaving
 * guest looping either would otherwise amplify at postMessage speed. Polls
 * get the larger budget: one in-flight poll per outstanding run is normal.
 * Server-side tenant budgets (ADR 0028) still apply; this is the cheap first
 * line.
 */
const MAX_IN_FLIGHT_CALLS = 8;
const MAX_IN_FLIGHT_POLLS = 16;

export interface AppMountProps {
  projectId: string;
  appName: string;
  /**
   * Host-provided context snapshot handed to the guest at mount. Re-mount
   * (change the `key`) when it changes; anything richer is one call away.
   */
  context: Pick<AppContext, "user" | "host"> & { tenantId: string };
  /** Rendered per non-ready view state; defaults to minimal text. */
  renderState?: (
    state: "loading" | "not_found" | "not_published",
  ) => React.ReactNode;
  /**
   * Which version to mount: "published" (default) is the active published
   * version; "dev" is the newest ready build of any kind — what the owner
   * is developing right now.
   */
  channel?: "published" | "dev";
  /**
   * The host's current design tokens. Injected into the guest document as
   * `--color-*` custom properties (before the app's own CSS) and kept live
   * over postMessage, so apps styled with the shared vocabulary match the
   * shell and follow theme switches without a reload.
   */
  theme?: AppHostTheme;
  className?: string;
}

interface ViewStateReady {
  state: "ready";
  appId: string;
  versionId: string;
  /** Absolute URL of the served guest document for this channel. */
  guestUrl: string;
}

type ViewState =
  | { state: "loading" }
  | { state: "not_found" }
  | { state: "not_published" }
  | ViewStateReady;

/**
 * Mounts a published app in a sandboxed iframe and brokers its workflow
 * calls.
 *
 * Isolation model: the iframe navigates to the API's served guest document
 * (never `srcdoc` — a local-scheme document inherits the host shell's CSP,
 * which can block the bundle's inline script outright) with
 * `sandbox="allow-scripts"` and **no** `allow-same-origin` — an opaque
 * origin with no cookies, no storage, and no reach into the host DOM or the
 * API origin. The guest holds zero credentials; every call arrives here via
 * postMessage and is forwarded with the app-audience headers, so the server
 * re-authorizes each one against the version's frozen workflow set. The
 * iframe cannot navigate the host or open popups; network inside the frame
 * is limited by the served document's default-deny CSP.
 */
export function AppMount({
  projectId,
  appName,
  context,
  renderState,
  channel,
  theme,
  className,
}: AppMountProps) {
  const { apiClient } = useCatamorphic();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [view, setView] = useState<ViewState>({ state: "loading" });
  const [height, setHeight] = useState(MIN_HEIGHT_PX);
  const inFlightCalls = useRef(0);
  const inFlightPolls = useRef(0);
  // The guest URL carries the mount-time theme (changing it would reload
  // the guest and lose its state); later switches arrive as messages.
  const initialTheme = useRef(theme).current;

  useEffect(() => {
    if (!theme || theme === initialTheme) return;
    frameRef.current?.contentWindow?.postMessage(
      {
        catamorphicApp: APP_PROTOCOL_VERSION,
        kind: "theme",
        theme,
      } satisfies HostToGuestMessage,
      "*",
    );
  }, [theme, initialTheme]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await apiClient.GET(
        "/api/projects/{projectId}/apps/{appName}/view-state",
        {
          params: {
            path: { projectId, appName },
            query: channel ? { channel } : undefined,
          },
        },
      );
      if (cancelled) return;
      const data = response.data;
      if (!data) {
        setView({ state: "not_found" });
        return;
      }
      switch (data.state) {
        case "ready":
          setView(data);
          return;
        case "not_published":
          setView({ state: "not_published" });
          return;
        default:
          setView({ state: "not_found" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiClient, projectId, appName, channel]);

  const audienceHeaders = useMemo(
    () =>
      view.state === "ready"
        ? {
            "X-Catamorphic-App-Id": view.appId,
            "X-Catamorphic-App-Version-Id": view.versionId,
          }
        : undefined,
    [view],
  );

  const handleGuestMessage = useCallback(
    async (message: GuestToHostMessage) => {
      if (view.state !== "ready" || !audienceHeaders) return;
      // Narrowed copy the hoisted handleCall below can close over.
      const headers = audienceHeaders;
      const frame = frameRef.current;
      if (!frame?.contentWindow) return;
      const reply = (payload: HostToGuestMessage) => {
        // srcdoc guests have an opaque origin, so "*" is the only valid
        // target; the message carries no secrets and names no credentials.
        frame.contentWindow?.postMessage(payload, "*");
      };

      if (message.kind === "resize") {
        setHeight(
          Math.min(MAX_HEIGHT_PX, Math.max(MIN_HEIGHT_PX, message.height)),
        );
        return;
      }

      const fail = (code: AppCallErrorCode, text: string) =>
        reply({
          catamorphicApp: APP_PROTOCOL_VERSION,
          kind: "result",
          callId: message.callId,
          ok: false,
          error: { code, message: text },
        });

      try {
        if (message.kind === "call") {
          const inputProblem = validateGuestInput(message.input);
          if (inputProblem) {
            fail("not_serializable", inputProblem);
            return;
          }
          if (inFlightCalls.current >= MAX_IN_FLIGHT_CALLS) {
            fail(
              "denied",
              `Too many concurrent calls (limit ${MAX_IN_FLIGHT_CALLS})`,
            );
            return;
          }
          inFlightCalls.current += 1;
          try {
            await handleCall(message);
          } finally {
            inFlightCalls.current -= 1;
          }
          return;
        }

        if (message.kind === "poll-run") {
          if (inFlightPolls.current >= MAX_IN_FLIGHT_POLLS) {
            fail(
              "denied",
              `Too many concurrent polls (limit ${MAX_IN_FLIGHT_POLLS})`,
            );
            return;
          }
          inFlightPolls.current += 1;
          let snapshot: BrokerRunSnapshot | null;
          try {
            snapshot = await fetchRunSnapshot({
              apiClient,
              runId: message.runId,
              headers,
            });
          } finally {
            inFlightPolls.current -= 1;
          }
          if (!snapshot) {
            fail("denied", "Run not found");
            return;
          }
          reply({
            catamorphicApp: APP_PROTOCOL_VERSION,
            kind: "result",
            callId: message.callId,
            ok: true,
            value: snapshot,
          });
        }
      } catch (error) {
        fail(
          "internal",
          error instanceof Error ? error.message : "App call failed",
        );
      }

      async function handleCall(
        message: Extract<GuestToHostMessage, { kind: "call" }>,
      ): Promise<void> {
        const response = await apiClient.POST(
          "/api/projects/{projectId}/workflows/{name}/runs",
          {
            params: { path: { projectId, name: message.workflowName } },
            // Input was JSON-validated above; the generated body type wants
            // the JsonValueInput shape.
            body: { input: message.input } as never,
            headers,
          },
        );
        if (response.error || !response.data) {
          fail("denied", "This app is not authorized to call that workflow");
          return;
        }
        const runId = response.data.id;
        if (message.mode === "start") {
          reply({
            catamorphicApp: APP_PROTOCOL_VERSION,
            kind: "result",
            callId: message.callId,
            ok: true,
            value: { runId },
          });
          return;
        }
        const outcome = await pollUntilTerminal({
          apiClient,
          runId,
          headers,
        });
        if (outcome.status === "completed") {
          reply({
            catamorphicApp: APP_PROTOCOL_VERSION,
            kind: "result",
            callId: message.callId,
            ok: true,
            value: outcome.output,
          });
        } else if (outcome.timedOut) {
          // The run is still going server-side; the guest can start+poll
          // instead of invoke if it expects long work. Distinct code so
          // apps don't render "workflow failed" for a workflow that may
          // yet succeed.
          fail(
            "timeout",
            `App call timed out after ${RUN_POLL_TIMEOUT_MS / 1000}s; run ${runId} may still complete`,
          );
        } else {
          fail("workflow_failed", outcome.error ?? `Run ${outcome.status}`);
        }
      }
    },
    [apiClient, audienceHeaders, projectId, view.state],
  );

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data: unknown = event.data;
      if (!isGuestMessage(data)) return;
      void handleGuestMessage(data);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [handleGuestMessage]);

  // Hand the guest its context snapshot once it can receive messages.
  const handleFrameLoad = useCallback(() => {
    const frame = frameRef.current;
    if (!frame?.contentWindow) return;
    const payload: HostToGuestMessage = {
      catamorphicApp: APP_PROTOCOL_VERSION,
      kind: "context",
      context,
    };
    frame.contentWindow.postMessage(payload, "*");
  }, [context]);

  if (view.state !== "ready") {
    return (
      <div className={className}>
        {renderState?.(view.state) ?? defaultStateText(view.state)}
      </div>
    );
  }

  return (
    <iframe
      ref={frameRef}
      className={className}
      title={`app-${appName}`}
      sandbox="allow-scripts allow-forms allow-downloads"
      src={guestSrc(view.guestUrl, initialTheme)}
      onLoad={handleFrameLoad}
      style={{ width: "100%", border: "none", height: `${height}px` }}
    />
  );
}

/**
 * The served guest document URL, with the mount-time theme riding along as
 * JSON so the first paint is already in the host's colors. The server
 * validates the theme and the browser cache key varies with it naturally.
 */
function guestSrc(guestUrl: string, theme?: AppHostTheme): string {
  if (!theme) return guestUrl;
  const url = new URL(guestUrl);
  url.searchParams.set("theme", JSON.stringify(theme));
  return url.toString();
}

function defaultStateText(
  state: "loading" | "not_found" | "not_published",
): string {
  switch (state) {
    case "loading":
      return "Loading app…";
    case "not_found":
      return "This app does not exist.";
    case "not_published":
      return "This app has not been published yet.";
    default:
      return assertNever(state);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled app view state: ${String(value)}`);
}

/** Size and depth bounds on untrusted guest input; JSON-ness is inherent. */
function validateGuestInput(input: unknown): string | null {
  let serialized: string;
  try {
    serialized = JSON.stringify(input) ?? "null";
  } catch {
    return "Workflow input must be JSON-serializable";
  }
  if (serialized.length > MAX_INPUT_BYTES) {
    return `Workflow input exceeds ${MAX_INPUT_BYTES} bytes`;
  }
  if (jsonDepth(input, MAX_INPUT_DEPTH) > MAX_INPUT_DEPTH) {
    return `Workflow input exceeds depth ${MAX_INPUT_DEPTH}`;
  }
  return null;
}

function jsonDepth(value: unknown, limit: number): number {
  if (limit <= 0) return Number.POSITIVE_INFINITY;
  if (typeof value !== "object" || value === null) return 0;
  let deepest = 0;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const depth = 1 + jsonDepth(child, limit - 1);
    if (depth > deepest) deepest = depth;
    if (deepest > limit) break;
  }
  return deepest;
}

const RUN_POLL_INTERVAL_MS = 750;
const RUN_POLL_TIMEOUT_MS = 120_000;

type BrokerClient = ReturnType<typeof useCatamorphic>["apiClient"];

interface BrokerRunSnapshot {
  runId: string;
  status: string;
  output: unknown;
  error: string | null;
  progress?: {
    discovered: number;
    succeeded: number;
    failed: number;
    skipped: number;
  };
}

async function fetchRunSnapshot(args: {
  apiClient: BrokerClient;
  runId: string;
  headers: Record<string, string>;
}): Promise<BrokerRunSnapshot | null> {
  const response = await args.apiClient.GET("/api/runs/{runId}", {
    params: { path: { runId: args.runId } },
    headers: args.headers,
  });
  const run = response.data;
  if (!run) return null;
  const batch = run.batchScopes?.[0];
  return {
    runId: run.id,
    status: run.status,
    output: run.result ?? null,
    error: run.error ?? null,
    progress: batch
      ? {
          discovered: batch.discovered,
          succeeded: batch.succeeded,
          failed: batch.failed,
          skipped: batch.skipped,
        }
      : undefined,
  };
}

async function pollUntilTerminal(args: {
  apiClient: BrokerClient;
  runId: string;
  headers: Record<string, string>;
}): Promise<BrokerRunSnapshot & { timedOut?: boolean }> {
  const startedAt = Date.now();
  for (;;) {
    const snapshot = await fetchRunSnapshot(args);
    if (!snapshot) {
      return {
        runId: args.runId,
        status: "failed",
        output: null,
        error: "Run not found",
      };
    }
    if (["completed", "failed", "canceled"].includes(snapshot.status)) {
      return snapshot;
    }
    if (Date.now() - startedAt > RUN_POLL_TIMEOUT_MS) {
      return { ...snapshot, timedOut: true };
    }
    await new Promise((resolve) => setTimeout(resolve, RUN_POLL_INTERVAL_MS));
  }
}
