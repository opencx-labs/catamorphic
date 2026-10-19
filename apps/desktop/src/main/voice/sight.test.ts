import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  desktopCapturer: { getSources: vi.fn() },
  screen: {},
  systemPreferences: { getMediaAccessStatus: () => "denied" },
}));

const { SpokenSights, sightFor, takePicture } = await import("./sight.js");

const sight = (at: number, said = "what PR is this") => ({
  at,
  said,
  projectId: "catamorphic",
  app: Promise.resolve(null),
  screen: Promise.resolve("The person is looking at: web page"),
  picture: Promise.resolve(null),
});

describe("what the person saw as they spoke", () => {
  it("pairs words with the stretch they were said in, or the hold they continue", () => {
    const sights = new Map([
      [3, "as the third began"],
      [5, "as the fifth began"],
    ]);
    // The fourth stretch carried on a hold begun in the third.
    expect(sightFor(sights, 4)).toBe("as the third began");
    // The fifth is still under way: kept for its own words.
    expect([...sights.keys()]).toEqual([5]);
    expect(sightFor(sights, 5)).toBe("as the fifth began");
    expect(sightFor(sights, 6)).toBeNull();
  });

  it("keeps each chat's latest for half an hour, a few chats at a time", () => {
    let now = 0;
    const sights = new SpokenSights(() => now);
    sights.set("assistant", sight(0, "first"));
    sights.set("assistant", sight(0, "second"));
    expect(sights.get("assistant")?.said).toBe("second");
    now = 30 * 60_000 + 1;
    expect(sights.get("assistant")).toBeNull();
    now = 0;
    for (let chat = 0; chat < 20; chat++) sights.set(`chat-${chat}`, sight(0));
    expect(sights.get("chat-0")).toBeNull();
    expect(sights.get("chat-19")).not.toBeNull();
  });

  it("takes no picture of another app without leave to record the screen", async () => {
    const capturePage = vi.fn();
    const window = {
      isDestroyed: () => false,
      webContents: { capturePage },
    } as unknown as Electron.BrowserWindow;
    expect(await takePicture(window, false)).toBeNull();
    expect(capturePage).not.toHaveBeenCalled();
  });

  it("pictures Work's window when Work is in front, no wider than it shows agents", async () => {
    const resized = { getSize: () => ({ width: 1600, height: 1000 }) };
    const image = {
      isEmpty: () => false,
      getSize: () => ({ width: 3200, height: 2000 }),
      resize: vi.fn(() => resized),
    };
    const window = {
      isDestroyed: () => false,
      webContents: { capturePage: vi.fn(async () => image) },
    } as unknown as Electron.BrowserWindow;
    expect(await takePicture(window, true)).toBe(resized);
    expect(image.resize).toHaveBeenCalledWith({ width: 1600 });
  });
});
