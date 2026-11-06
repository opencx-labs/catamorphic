import { describe, expect, it, vi } from "vitest";
import { moduleSource } from "./module.js";

const requests = vi.hoisted(() => ({
  load: vi.fn<(input: unknown) => Promise<unknown>>(),
}));
vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    sidebarSourceRequest: requests.load,
    sidebarSourceCancel: vi.fn(),
  },
}));

describe("module source revision", () => {
  it("advances its revision only on a successfully validated revisioned page", async () => {
    const source = moduleSource({ projectId: "project", ownerId: "tasks" });
    const request = { parentId: null, signal: new AbortController().signal };
    expect(source.revision?.()).toBeUndefined();
    requests.load.mockResolvedValueOnce({
      items: [{ id: "one", label: "One" }],
      revision: "first",
    });
    await source.load(request);
    expect(source.revision?.()).toBe("first");
    requests.load.mockResolvedValueOnce({ items: [] });
    await source.load(request);
    expect(source.revision?.()).toBe("first");
    requests.load.mockRejectedValueOnce(new Error("Broken helper"));
    await expect(source.load(request)).rejects.toThrow("Broken helper");
    expect(source.revision?.()).toBe("first");
    requests.load.mockResolvedValueOnce({ items: null, revision: "invalid" });
    await expect(source.load(request)).rejects.toThrow("no collection page");
    expect(source.revision?.()).toBe("first");
    requests.load.mockResolvedValueOnce({ items: [], revision: "second" });
    await source.load(request);
    expect(source.revision?.()).toBe("second");
  });
});
