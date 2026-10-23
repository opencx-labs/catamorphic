import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, ipcMain: {} }));
const { parseWorkCall } = await import("./sidebar-source-ipc.js");

describe("a module's requests of Work (ADR 0234, 0272)", () => {
  const grants = { lists: ["tabs"], workflows: ["listTickets"] };

  it("allows what its access declares", () => {
    expect(parseWorkCall({ op: "read", source: "tabs" }, grants)).toEqual({
      op: "read",
      source: "tabs",
    });
    expect(
      parseWorkCall(
        { op: "execute", source: "tabs", itemId: "browser:1", action: "close" },
        grants,
      ),
    ).toMatchObject({ op: "execute", action: "close" });
    expect(
      parseWorkCall(
        { op: "call", workflow: "listTickets", input: { mine: true } },
        grants,
      ),
    ).toEqual({ op: "call", workflow: "listTickets", input: { mine: true } });
  });

  it("refuses lists and workflows its access does not declare", () => {
    expect(() =>
      parseWorkCall({ op: "read", source: "chats" }, grants),
    ).toThrow("add it to lists in catamorphic.access");
    expect(() =>
      parseWorkCall(
        { op: "execute", source: "chats", itemId: "s1", action: "archive" },
        grants,
      ),
    ).toThrow("add it to lists in catamorphic.access");
    expect(() =>
      parseWorkCall({ op: "call", workflow: "deleteEverything" }, grants),
    ).toThrow("add it to workflows in catamorphic.access");
    expect(() => parseWorkCall({ op: "read", source: "tabs" }, {})).toThrow(
      "does not include",
    );
  });

  it("lets a chips module read its chat's chips only", () => {
    expect(
      parseWorkCall(
        { op: "read", source: "chips" },
        { lists: ["chips"] },
        "chips",
      ),
    ).toEqual({ op: "read", source: "chips" });
    expect(() =>
      parseWorkCall(
        { op: "read", source: "chats" },
        { lists: ["chats", "chips"] },
        "chips",
      ),
    ).toThrow("chips only");
  });

  it("refuses what is not a request at all", () => {
    expect(() =>
      parseWorkCall({ op: "write", source: "tabs" }, grants),
    ).toThrow();
    expect(() => parseWorkCall({ op: "read" }, grants)).toThrow();
    expect(() =>
      parseWorkCall(
        {
          op: "execute",
          source: "tabs",
          itemId: "x",
          action: "a",
          values: { a: "1", b: "2", c: "3", d: "4", e: "5" },
        },
        grants,
      ),
    ).toThrow("four");
  });
});
