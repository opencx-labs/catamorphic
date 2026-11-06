import { describe, expect, it } from "vitest";
import { type RestoringGuest, restoreGuestHistory } from "./history-restore.js";

const HISTORY = {
  index: 1,
  entries: [
    { url: "https://example.com/", title: "Example" },
    { url: "https://mail.example.com/inbox#thread", title: "Inbox" },
  ],
};

/**
 * A guest whose restore settles as told. Like Electron, it refuses a load
 * asked for while the navigation that settled the restore is still on the
 * stack: until the task that rejected it has ended.
 */
function guest({
  restore,
  loading = false,
  destroyed = false,
}: {
  restore: "resolves" | { errno: number };
  loading?: boolean;
  destroyed?: boolean;
}) {
  const loads: { url: string; refused: boolean }[] = [];
  let navigating = false;
  const fake: RestoringGuest = {
    navigationHistory: {
      restore: () => {
        if (restore === "resolves") return Promise.resolve();
        navigating = true;
        setImmediate(() => {
          navigating = false;
        });
        return Promise.reject(
          Object.assign(new Error("restore failed"), restore),
        );
      },
    },
    isDestroyed: () => destroyed,
    isLoading: () => loading,
    loadURL: async (url) => {
      loads.push({ url, refused: navigating });
    },
  };
  return { fake, loads };
}

describe("restoreGuestHistory", () => {
  it("leaves a restored tab alone", async () => {
    const { fake, loads } = guest({ restore: "resolves" });
    await restoreGuestHistory({ guest: fake, history: HISTORY });
    expect(loads).toEqual([]);
  });

  it("loads the tab's page once the failed restore's navigation is off the stack", async () => {
    const { fake, loads } = guest({ restore: { errno: -2 } });
    await restoreGuestHistory({ guest: fake, history: HISTORY });
    expect(loads).toEqual([
      { url: "https://mail.example.com/inbox#thread", refused: false },
    ]);
  });

  it("leaves a restore a newer navigation replaced to that navigation", async () => {
    const { fake, loads } = guest({ restore: { errno: -3 } });
    await restoreGuestHistory({ guest: fake, history: HISTORY });
    expect(loads).toEqual([]);
  });

  it("loads nothing over a page already loading, or into a closed tab", async () => {
    for (const state of [{ loading: true }, { destroyed: true }]) {
      const { fake, loads } = guest({ restore: { errno: -2 }, ...state });
      await restoreGuestHistory({ guest: fake, history: HISTORY });
      expect(loads).toEqual([]);
    }
  });
});
