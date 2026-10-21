// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfilesData } from "../lib/desktop-api";
import { SyncedNote, syncPartners } from "./profile-settings-sync";

vi.mock("../lib/desktop-api", () => ({ desktopApi: {} }));

const data: ProfilesData = {
  defaultProfileId: "work",
  profiles: [
    { id: "work", name: "Work", color: "#f95225", projectIds: [] },
    {
      id: "personal",
      name: "Personal",
      color: "#4c8dff",
      projectIds: [],
      syncedFrom: { appearance: "work" },
    },
    {
      id: "side",
      name: "Side",
      color: "#3dba7c",
      projectIds: [],
      syncedFrom: { appearance: "work", macros: "gone" },
    },
  ],
};
const byId = (id: string) => {
  const profile = data.profiles.find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`No fixture profile ${id}`);
  return profile;
};
const work = byId("work");
const personal = byId("personal");
const side = byId("side");

describe("SyncedNote", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  it("names everyone sharing a part, from the owner or a follower", () => {
    expect(
      syncPartners(work, data, "appearance").map(({ name }) => name),
    ).toEqual(["Personal", "Side"]);
    expect(
      syncPartners(personal, data, "appearance").map(({ name }) => name),
    ).toEqual(["Work", "Side"]);
    // A link to a removed profile shares nothing.
    expect(syncPartners(side, data, "macros")).toEqual([]);
  });

  it("speaks only under shared categories", () => {
    act(() =>
      root.render(
        <>
          <SyncedNote profile={personal} data={data} part="appearance" />
          <SyncedNote profile={personal} data={data} part="macros" />
          <SyncedNote profile={personal} data={data} part="agents" />
        </>,
      ),
    );
    expect(container.textContent).toBe(
      "Synced with Work and Side. Profile changes here apply to all of them.",
    );
  });
});
