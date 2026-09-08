import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeProfile,
  addRemoteConnection,
  getState,
  removeConnection,
} from "../lib/store.js";
import { ProfilesScreen } from "./profiles-screen.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const roots: Root[] = [];
const connectionIds: string[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  const profile = activeProfile(getState());
  for (const connectionId of connectionIds.splice(0)) {
    removeConnection(profile.id, connectionId);
  }
});

describe("ProfilesScreen", () => {
  it("shows remote authentication state and a reconnect action", () => {
    const profile = activeProfile(getState());
    const connection = addRemoteConnection({
      profileId: profile.id,
      link: {
        serverUrl: "https://brain.acme.dev/api",
        remoteProjectId: "project-1",
        remoteProjectName: "Acme Brain",
      },
    });
    connectionIds.push(connection.id);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    act(() => root.render(<ProfilesScreen />));

    expect(container.textContent).toContain("Sign in required");
    expect(
      container.querySelector('[data-testid="profile-remote-sign-in"]'),
    ).toBeTruthy();
  });
});
