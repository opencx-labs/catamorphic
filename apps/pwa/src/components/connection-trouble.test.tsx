import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { RemotePwaConnection } from "../lib/store.js";
import { ConnectionTrouble } from "./connection-trouble.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const roots: Root[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

describe("ConnectionTrouble", () => {
  it("offers browser sign-in when a remote needs authentication", () => {
    const connection: RemotePwaConnection = {
      id: "remote-1",
      kind: "remote",
      serverUrl: "https://brain.acme.dev/api",
      projectId: "project-1",
      projectName: "Acme Brain",
      addedAt: "2026-08-26T00:00:00.000Z",
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    act(() => {
      root.render(
        <ConnectionTrouble
          connection={connection}
          projectId="project-1"
          message="Sign in to this server again."
        />,
      );
    });

    expect(
      container.querySelector('[data-testid="remote-sign-in"]'),
    ).toBeTruthy();
    expect(container.textContent).toContain("Sign in to Acme Brain");
  });
});
