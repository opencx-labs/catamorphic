import { describe, expect, it } from "vitest";
import { formatHash, parseHash, type Route, routeDepth } from "./nav.js";

describe("nav", () => {
  const roundTrips: Route[] = [
    { kind: "projects" },
    { kind: "connect" },
    { kind: "profiles" },
    { kind: "sessions", connectionId: "c1", projectId: "p1" },
    { kind: "chat", connectionId: "c1", projectId: "p1", sessionId: "s1" },
    { kind: "chat", connectionId: "c1", projectId: "p1", sessionId: null },
  ];

  it("round-trips every route through the hash", () => {
    for (const route of roundTrips) {
      expect(parseHash(formatHash(route))).toEqual(route);
    }
  });

  it("falls back to projects for junk hashes", () => {
    expect(parseHash("#/whatever/else")).toEqual({ kind: "projects" });
    expect(parseHash("")).toEqual({ kind: "projects" });
  });

  it("orders depth projects < sessions < chat", () => {
    const [projects, , , sessionsRoute, chat] = roundTrips;
    expect(routeDepth(projects as Route)).toBeLessThan(
      routeDepth(sessionsRoute as Route),
    );
    expect(routeDepth(sessionsRoute as Route)).toBeLessThan(
      routeDepth(chat as Route),
    );
  });
});
