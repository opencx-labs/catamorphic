// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticationRequiredCard } from "./authentication-required-card.js";

const authorize = vi.fn();
const complete = vi.fn();

vi.mock("@catamorphic/react", () => ({
  useAuthorizeConnection: () => ({
    mutateAsync: authorize,
    isPending: false,
    error: null,
  }),
  useCompleteConnectionAuthorization: () => ({
    mutateAsync: complete,
    isPending: false,
    error: null,
  }),
}));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const roots: Root[] = [];
const containers: HTMLElement[] = [];

beforeEach(() => {
  authorize.mockReset();
  complete.mockReset();
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
});

function mount(args: {
  onOpenLink?: (url: string) => void;
  onAuthorized?: () => void;
}) {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <AuthenticationRequiredCard
        projectId="project-1"
        environment="company"
        requirement={{
          alias: "directory",
          providerKind: "google-workspace",
          principalKinds: ["member"],
        }}
        onOpenLink={args.onOpenLink}
        onAuthorized={args.onAuthorized ?? (() => {})}
      />,
    );
  });
  return container;
}

describe("AuthenticationRequiredCard", () => {
  it("opens URL authorization and explains that the message stays queued", async () => {
    authorize.mockResolvedValue({
      authorizationId: "attempt-1",
      challenge: { kind: "url", url: "https://accounts.example.test" },
    });
    const onOpenLink = vi.fn();
    const container = mount({ onOpenLink });

    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")?.click();
    });

    expect(onOpenLink).toHaveBeenCalledWith("https://accounts.example.test");
    expect(container.textContent).toContain(
      "The message stays queued until authentication succeeds.",
    );
  });

  it("submits and clears form credentials before resuming", async () => {
    authorize.mockResolvedValue({
      authorizationId: "attempt-2",
      challenge: {
        kind: "form",
        fields: [
          { name: "apiKey", label: "API key", secret: true, required: true },
        ],
      },
    });
    complete.mockResolvedValue({});
    const onAuthorized = vi.fn();
    const container = mount({ onAuthorized });
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")?.click();
    });
    const input = container.querySelector<HTMLInputElement>("input");
    expect(input?.type).toBe("password");
    act(() => {
      if (input) {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set?.call(input, "sensitive-value");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await act(async () => {
      container
        .querySelector<HTMLFormElement>("form")
        ?.dispatchEvent(
          new SubmitEvent("submit", { bubbles: true, cancelable: true }),
        );
    });

    expect(complete).toHaveBeenCalledWith({
      authorizationId: "attempt-2",
      callback: { apiKey: "sensitive-value" },
    });
    expect(onAuthorized).toHaveBeenCalledOnce();
    expect(container.querySelector("input")).toBeNull();
  });
});
