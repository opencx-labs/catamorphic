import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, ipcMain: {} }));
const { parseWorkCall } = await import("./sidebar-source-ipc.js");

describe("a module's requests of Work (ADR 0234)", () => {
  const grants = { collections: ["tabs"], workflows: ["listTickets"] };

  it("allows what its section grants", () => {
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

  it("refuses lists and workflows the section does not grant", () => {
    expect(() =>
      parseWorkCall({ op: "read", source: "chats" }, grants),
    ).toThrow("add it to collections");
    expect(() =>
      parseWorkCall(
        { op: "execute", source: "chats", itemId: "s1", action: "archive" },
        grants,
      ),
    ).toThrow("add it to collections");
    expect(() =>
      parseWorkCall({ op: "call", workflow: "deleteEverything" }, grants),
    ).toThrow("add it to workflows");
    expect(() =>
      parseWorkCall(
        { op: "read", source: "tabs" },
        { collections: [], workflows: [] },
      ),
    ).toThrow("does not grant");
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
