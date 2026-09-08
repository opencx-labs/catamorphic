import { afterEach, describe, expect, it, vi } from "vitest";

const search = vi.hoisted(() =>
  vi.fn(async (query: string) => [{ name: query, description: "test" }]),
);
vi.mock("@catamorphic/mcp", () => ({
  searchMcpRegistry: search,
  fetchMarketplace: vi.fn(),
  probeMcpServer: vi.fn(),
}));
vi.mock("electron", () => ({ safeStorage: {} }));

import { ConnectorsService } from "./connectors.js";

afterEach(() => {
  vi.useRealTimers();
  search.mockClear();
});

describe("connector search retention", () => {
  it("bounds distinct searches and removes expired entries on later searches", async () => {
    vi.useFakeTimers();
    const service = new ConnectorsService({
      connectorsDirFor: () => "/unused",
      connectionsFor: () => {
        throw new Error("not used by registry search");
      },
    });
    for (let i = 0; i < 100; i++) await service.searchRegistry(`query-${i}`);
    expect(Reflect.get(service, "registryQueryCache").size).toBeLessThanOrEqual(
      64,
    );
    await service.searchRegistry("query-99");
    expect(search).toHaveBeenCalledTimes(100);
    await service.searchRegistry("query-0");
    expect(search).toHaveBeenCalledTimes(101);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    await service.searchRegistry("fresh");
    expect(Reflect.get(service, "registryQueryCache").size).toBe(1);
  });
});
