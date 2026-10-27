// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatFolder } from "./chat-folder.js";
import { ResourceInspector } from "./resource-inspector.js";
import { SessionArtifacts } from "./session-artifacts.js";

/** What the reads the chat's status popup shows return, set per test. */
const reads = vi.hoisted(() => ({
  checkout: { isPending: true, data: undefined as unknown },
  available: { isPending: true, data: undefined as unknown },
  artifacts: { isLoading: true, data: undefined as unknown, error: null },
}));

vi.mock("../lib/desktop-api.js", () => ({ desktopApi: {} }));
vi.mock("../lib/use-session-checkout.js", () => ({
  useSessionCheckout: () => reads.checkout,
  useWorktreesAvailable: () => reads.available,
  sessionCheckoutKey: () => ["checkout"],
  worktreesAvailableKey: () => ["available"],
}));
vi.mock("@catamorphic/react", () => ({
  useSessionArtifacts: () => reads.artifacts,
  useAppPresentations: () => [],
}));

/**
 * The chat's status popup opens at its size: its folder row and its
 * artifacts list hold it, unseen, until their reads land, rather than
 * appearing with "Checking" and growing.
 */
describe("the chat popup's reads", () => {
  let container: HTMLDivElement;
  let root: Root;
  const client = new QueryClient();

  beforeEach(() => {
    vi.useFakeTimers();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    reads.checkout = { isPending: true, data: undefined };
    reads.available = { isPending: true, data: undefined };
    reads.artifacts = { isLoading: true, data: undefined, error: null };
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  const render = (content: ReactNode) =>
    root.render(
      <QueryClientProvider client={client}>
        <ResourceInspector label="Session status" content={content}>
          {(props) => (
            <button type="button" {...props}>
              Status
            </button>
          )}
        </ResourceInspector>
      </QueryClientProvider>,
    );
  const panel = () => document.querySelector("[data-resource-inspector]");

  it("waits for where a started chat works", async () => {
    const folder = () => (
      <dl>
        <ChatFolder projectId="p" sessionId="s" busy={false} />
      </dl>
    );
    await act(async () => render(folder()));
    await act(async () => container.querySelector("button")?.focus());
    expect(panel()?.getAttribute("data-open")).toBeNull();
    reads.checkout = { isPending: false, data: undefined };
    await act(async () => render(folder()));
    expect(panel()?.getAttribute("data-open")).toBe("true");
  });

  it("opens after its grace period even if a read is still pending", async () => {
    await act(async () =>
      render(
        <dl>
          <ChatFolder projectId="p" sessionId="s" busy={false} />
        </dl>,
      ),
    );
    await act(async () => container.querySelector("button")?.focus());
    expect(panel()?.getAttribute("data-open")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(panel()?.getAttribute("data-open")).toBe("true");
  });

  it("waits, for a new chat, for whether it can have a worktree", async () => {
    const folder = () => (
      <dl>
        <ChatFolder projectId="p" sessionId={undefined} busy={false} />
      </dl>
    );
    await act(async () => render(folder()));
    await act(async () => container.querySelector("button")?.focus());
    expect(panel()?.getAttribute("data-open")).toBeNull();
    reads.available = { isPending: false, data: true };
    await act(async () => render(folder()));
    expect(panel()?.getAttribute("data-open")).toBe("true");
  });

  it("waits for the chat's artifacts", async () => {
    const artifacts = () => (
      <SessionArtifacts projectId="p" sessionId="s" onOpen={() => {}} />
    );
    await act(async () => render(artifacts()));
    await act(async () => container.querySelector("button")?.focus());
    expect(panel()?.getAttribute("data-open")).toBeNull();
    reads.artifacts = { isLoading: false, data: [], error: null };
    await act(async () => render(artifacts()));
    expect(panel()?.getAttribute("data-open")).toBe("true");
  });
});
