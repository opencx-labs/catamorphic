import { act, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { apiUrl, HttpResponse, http } from "../../test/handlers.js";
import { renderHookWithProviders } from "../../test/render.js";
import { server } from "../../test/server.js";
import {
  PROJECT_ID,
  SESSION_ID,
  sessionDetail,
  sessionFields,
  snapshot,
  sseStream,
  stored,
} from "../../test/session-fixtures.js";
import {
  useAgentSession,
  useAgentSessionFields,
} from "../use-agent-session.js";

const BASE = `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}`;
const pullRequests = [
  { url: "https://github.com/acme/web/pull/5", number: 5, state: "open" },
];

/** Serve one session, counting snapshot loads and stream connections. */
function serve() {
  const streams: Array<ReturnType<typeof sseStream>> = [];
  let snapshots = 0;
  server.use(
    http.get(apiUrl(BASE), () => {
      snapshots += 1;
      return HttpResponse.json(
        sessionDetail(
          snapshot({
            sequence: 3,
            session: sessionFields({ metadata: { note: "first" } }),
          }),
        ),
      );
    }),
    http.get(apiUrl(`${BASE}/events`), () => {
      const stream = sseStream();
      streams.push(stream);
      return stream.response();
    }),
  );
  return { streams, snapshots: () => snapshots };
}

describe("useAgentSessionFields (ADR 0225)", () => {
  it("follows what the conversation's live reader folds, without a stream of its own", async () => {
    const served = serve();
    const { result } = renderHookWithProviders(() => ({
      live: useAgentSession(PROJECT_ID, SESSION_ID),
      beside: useAgentSessionFields(PROJECT_ID, SESSION_ID),
    }));
    await waitFor(() => expect(served.streams).toHaveLength(1));
    expect(result.current.beside.fields?.metadata).toEqual({ note: "first" });
    act(() =>
      served.streams[0]?.send({
        type: "events",
        events: [
          stored(4, {
            type: "session.changed",
            session: { metadata: { pull_requests: pullRequests } },
          }),
        ],
      }),
    );
    await waitFor(() =>
      expect(result.current.beside.fields?.metadata).toEqual({
        pull_requests: pullRequests,
      }),
    );
    expect(served.snapshots()).toBe(1);
    expect(served.streams).toHaveLength(1);
  });

  it("loads once on its own and never streams", async () => {
    const served = serve();
    const { result } = renderHookWithProviders(() =>
      useAgentSessionFields(PROJECT_ID, SESSION_ID),
    );
    await waitFor(() =>
      expect(result.current.fields?.metadata).toEqual({ note: "first" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(served.snapshots()).toBe(1);
    expect(served.streams).toHaveLength(0);
  });

  it("reads nothing without a session", () => {
    const served = serve();
    const { result } = renderHookWithProviders(() =>
      useAgentSessionFields(PROJECT_ID, undefined),
    );
    expect(result.current.fields).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(served.snapshots()).toBe(0);
  });
});
