// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi, type ProfileSummary } from "../lib/desktop-api.js";
import { connectionsLabel, ProfileInspector } from "./profile-inspector";

vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: { profileSummary: vi.fn() },
}));

const project = (id: string, name: string) => ({
  id,
  name,
  storageType: "managed" as const,
  remoteUrl: null,
  remoteOwnership: null,
  remoteDivergedAt: null,
  defaultBranch: "main",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});
const projects = [
  project("p1", "Alpha"),
  project("p2", "Beta"),
  project("p3", "Gamma"),
  project("p4", "Delta"),
  project("p5", "Epsilon"),
  project("p6", "Zeta"),
  project("p7", "Eta"),
  project("other", "Not mine"),
];
const profile = {
  id: "8b2f4c1e-0000-4000-8000-000000000001",
  name: "Work",
  color: "#e5484d",
  projectIds: ["p1", "p2", "p3", "p4", "p5", "p6", "p7"],
  defaultProjectId: "p3",
};

describe("ProfileInspector", () => {
  let container: HTMLDivElement;
  let root: Root;
  let summary: {
    resolve: (value: ProfileSummary) => void;
    reject: (error: Error) => void;
  };

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(desktopApi.profileSummary).mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          summary = { resolve, reject };
        }),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  const render = async (
    overrides: { defaultProfileId?: string } = {},
    handlers = { onOpenProject: vi.fn(), onOpenSettings: vi.fn() },
  ) => {
    await act(async () => {
      root.render(
        <ProfileInspector
          profile={profile}
          data={{
            profiles: [profile],
            defaultProfileId: overrides.defaultProfileId ?? profile.id,
          }}
          projects={projects}
          {...handlers}
        />,
      );
    });
    return handlers;
  };
  const text = () => container.textContent ?? "";

  it("names the profile without its id, and marks the default", async () => {
    await render();
    expect(text()).toContain("Work");
    expect(text()).toContain("Default");
    expect(text()).not.toContain(profile.id);
    expect(text()).not.toContain("App opens with");
    await render({ defaultProfileId: "another" });
    expect(text()).not.toContain("Default");
  });

  it("lists its projects with the default first, and opens one on click", async () => {
    const { onOpenProject } = await render();
    const rows = [...container.querySelectorAll("li button")];
    expect(rows.map((row) => row.textContent)).toEqual([
      "GammaOpens first",
      "Alpha",
      "Beta",
      "Delta",
      "Epsilon",
    ]);
    expect(text()).toContain("2 more");
    expect(text()).not.toContain("Not mine");
    await act(async () => (rows[1] as HTMLButtonElement).click());
    expect(onOpenProject).toHaveBeenCalledWith("p1");
  });

  it("opens settings from the gear", async () => {
    const { onOpenSettings } = await render();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Open settings for Work"]',
        )
        ?.click(),
    );
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("shows the default agent and connections once loaded", async () => {
    await render();
    expect(desktopApi.profileSummary).toHaveBeenCalledWith(profile.id);
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(2);
    await act(async () =>
      summary.resolve({
        agent: { name: "Reviewer", harness: "claude-code" },
        connections: ["Linear", "Slack", "Sentry", "Notion"],
      }),
    );
    expect(container.querySelector(".animate-pulse")).toBeNull();
    expect(text()).toContain("Reviewer");
    expect(text()).toContain("Linear, Slack, Sentry and 1 more");
  });

  it("says so when the summary has nothing, or cannot load", async () => {
    await render();
    await act(async () => summary.resolve({ agent: null, connections: [] }));
    expect(text().match(/None/g)).toHaveLength(2);
    await act(async () => root.render(<div />));
    await render();
    await act(async () => summary.reject(new Error("gone")));
    expect(text()).toContain("Unavailable");
  });
});

it("names up to three connections", () => {
  expect(connectionsLabel(["Linear"])).toBe("Linear");
  expect(connectionsLabel(["A", "B", "C"])).toBe("A, B, C");
  expect(connectionsLabel(["A", "B", "C", "D", "E"])).toBe(
    "A, B, C and 2 more",
  );
});
