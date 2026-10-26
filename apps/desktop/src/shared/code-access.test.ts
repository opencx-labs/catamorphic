import { describe, expect, it } from "vitest";
import {
  accessBeyond,
  accessText,
  describeAccess,
  hostAllowed,
  isEmptyAccess,
  parseCodeAccess,
} from "./code-access.js";

describe("code access (ADR 0277)", () => {
  it("reads a declaration, sorted and without repeats", () => {
    expect(
      parseCodeAccess(
        {
          hosts: ["API.Linear.app", "api.linear.app", "*.example.com"],
          lists: ["tabs", "chats"],
          workflows: ["listTickets"],
          reads: ["~/notes"],
          writes: ["todos.md"],
        },
        "package.json",
      ),
    ).toEqual({
      hosts: ["*.example.com", "api.linear.app"],
      lists: ["chats", "tabs"],
      workflows: ["listTickets"],
      reads: ["~/notes"],
      writes: ["todos.md"],
    });
    expect(parseCodeAccess(undefined, "package.json")).toEqual({});
    expect(isEmptyAccess(parseCodeAccess({ hosts: [] }, "p"))).toBe(true);
  });

  it("refuses what is not a declaration, saying what to fix", () => {
    for (const [raw, message] of [
      [{ network: true }, "unknown keys network"],
      [{ hosts: ["https://api.example.com"] }, "hosts are names"],
      [{ hosts: ["*"] }, "hosts are names"],
      [{ lists: ["work:chats"] }, "lists name Work's lists"],
      [{ reads: ["notes"] }, "from / or ~/"],
      [{ writes: ["output/../.git/hooks"] }, "writes name"],
      [{ reads: ["~/notes/../.ssh"] }, "reads name"],
      [{ workflows: "all" }, "workflows name"],
      [["hosts"], "must be an object"],
    ] as const)
      expect(() => parseCodeAccess(raw, "pkg"), JSON.stringify(raw)).toThrow(
        message,
      );
  });

  it("asks only for what is new, wildcards and folders covering what is under them", () => {
    const approved = parseCodeAccess(
      { hosts: ["*.example.com"], lists: ["tabs"], writes: ["notes"] },
      "p",
    );
    expect(
      accessBeyond(
        approved,
        parseCodeAccess(
          {
            hosts: ["api.example.com", "example.com", "evil.test"],
            lists: ["tabs", "chats"],
            writes: ["notes/today.md", "notes-old"],
          },
          "p",
        ),
      ),
    ).toEqual({
      // The bare domain is not under *.example.com.
      hosts: ["evil.test", "example.com"],
      lists: ["chats"],
      writes: ["notes-old"],
    });
    expect(isEmptyAccess(accessBeyond(approved, approved))).toBe(true);
    expect(accessBeyond(null, { lists: ["tabs"] })).toEqual({
      lists: ["tabs"],
    });
  });

  it("matches hosts and ports as declared", () => {
    const hosts = ["api.linear.app", "*.example.com", "localhost:11434"];
    expect(hostAllowed(hosts, "api.linear.app", 443)).toBe(true);
    expect(hostAllowed(hosts, "API.LINEAR.APP", 80)).toBe(true);
    expect(hostAllowed(hosts, "api.linear.app", 8443)).toBe(false);
    expect(hostAllowed(hosts, "a.b.example.com", 443)).toBe(true);
    expect(hostAllowed(hosts, "example.com", 443)).toBe(false);
    expect(hostAllowed(hosts, "notexample.com", 443)).toBe(false);
    expect(hostAllowed(hosts, "localhost", 11434)).toBe(true);
    expect(hostAllowed(hosts, "localhost", 443)).toBe(false);
    expect(hostAllowed(undefined, "api.linear.app", 443)).toBe(false);
  });

  it("never treats parent traversal as a narrower file grant", () => {
    expect(
      accessBeyond(
        { writes: ["output"] },
        {
          writes: ["output/../.git/hooks"],
        },
      ),
    ).toEqual({ writes: ["output/../.git/hooks"] });
  });

  it("is the same text whatever order it was written in", () => {
    expect(accessText({ hosts: ["b.test", "a.test"] })).toBe(
      accessText({ hosts: ["a.test", "b.test"] }),
    );
    expect(accessText({ hosts: ["a.test"] })).not.toBe(
      accessText({ hosts: ["a.test"], lists: ["tabs"] }),
    );
  });

  it("says what it reaches in Work's words", () => {
    expect(
      describeAccess({
        lists: ["chats", "mystery"],
        workflows: ["listTickets"],
        hosts: ["api.linear.app", "*.example.com"],
        reads: ["~/notes"],
        writes: ["todos.md"],
      }),
    ).toEqual([
      "Read and act on your chats",
      "Read and act on Work's mystery list",
      "Run the listTickets workflow",
      "Reach api.linear.app",
      "Reach any address under example.com",
      "Read ~/notes",
      "Change todos.md",
    ]);
  });

  it("says when what it changes can run commands as the person", () => {
    expect(
      describeAccess({
        writes: [".", ".claude/settings.json", ".git/hooks", "notes"],
      }),
    ).toEqual([
      "Change any file in this project (including hooks and settings that run commands as you)",
      "Change .claude/settings.json (what is there can run commands as you)",
      "Change .git/hooks (what is there can run commands as you)",
      "Change notes",
    ]);
  });
});
