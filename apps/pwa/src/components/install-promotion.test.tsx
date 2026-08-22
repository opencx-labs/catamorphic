import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstallPromotion } from "./install-promotion.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function nativeInstallEvent(): Event {
  const event = new Event("beforeinstallprompt", { cancelable: true });
  Object.defineProperties(event, {
    prompt: { value: () => Promise.resolve() },
    userChoice: {
      value: Promise.resolve({ outcome: "dismissed", platform: "web" }),
    },
  });
  return event;
}

describe("InstallPromotion installed state", () => {
  it("stays hidden when installation finishes while promotion is disabled", () => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false }) as MediaQueryList),
    );
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);

    act(() => root.render(<InstallPromotion enabled={false} />));
    act(() => window.dispatchEvent(nativeInstallEvent()));
    act(() => window.dispatchEvent(new Event("appinstalled")));
    act(() => root.render(<InstallPromotion enabled />));

    expect(
      container.querySelector('[data-testid="install-prompt"]'),
    ).toBeNull();
  });
});
