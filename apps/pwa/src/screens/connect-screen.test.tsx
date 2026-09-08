import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectScreen, stashPendingLink } from "./connect-screen.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

function renderConnectScreen(): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<ConnectScreen canGoBack={false} />));
  return container;
}

describe("ConnectScreen", () => {
  it("shows a credential-free locator as browser sign-in", () => {
    stashPendingLink({
      serverUrl: "https://brain.acme.dev/api",
      remoteProjectId: "project-1",
      remoteProjectName: "Acme Brain",
    });

    const container = renderConnectScreen();
    const input = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="connect-input"]',
    );

    expect(input?.value).toContain("server=");
    expect(input?.value).toContain("project=");
    expect(input?.value).not.toContain("token=");
    expect(input?.placeholder).not.toContain("token");
    expect(
      container.querySelector('[data-testid="connect-submit"]')?.textContent,
    ).toContain("Sign in");
  });

  it("offers direct sign-in when the PWA is served by a Catamorphic server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/.well-known/oauth-protected-resource") {
          return Response.json({ resource: `${window.location.origin}/api` });
        }
        return new Response(null, { status: 404 });
      }),
    );

    const container = renderConnectScreen();
    await act(async () => {});

    const buttons = Array.from(container.querySelectorAll("button"));
    expect(
      buttons.some((button) =>
        button.textContent?.includes("Sign in to this server"),
      ),
    ).toBe(true);
    const links = Array.from(container.querySelectorAll("a"));
    expect(
      links.find((link) => link.textContent?.includes("Get the desktop app"))
        ?.href,
    ).toBe("https://catamorphic.ai/desktop/");
    expect(
      links.find((link) => link.textContent?.includes("Connect with MCP"))
        ?.href,
    ).toBe("https://catamorphic.ai/agents/");
  });

  it("announces an invalid locator after submission", () => {
    const container = renderConnectScreen();
    const input = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="connect-input"]',
    );
    const form = container.querySelector("form");
    expect(input).toBeTruthy();
    expect(form).toBeTruthy();
    act(() => {
      if (input) {
        input.value = "not a locator";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      form?.dispatchEvent(
        new SubmitEvent("submit", { bubbles: true, cancelable: true }),
      );
    });

    expect(input?.getAttribute("aria-invalid")).toBe("true");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "connect link",
    );
  });
});
