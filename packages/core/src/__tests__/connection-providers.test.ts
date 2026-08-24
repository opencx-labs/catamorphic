import { describe, expect, it } from "vitest";
import { ConnectionProviderRegistry } from "../services/connection-providers.js";
import {
  assertConnectionAlias,
  connectionMcpServerName,
} from "../services/connection-types.js";

const provider = {
  kind: "fake",
  displayName: "Fake",
  invoke: async () => null,
};

describe("ConnectionProviderRegistry", () => {
  it("rejects duplicates and returns an immutable roster copy", () => {
    expect(() => new ConnectionProviderRegistry([provider, provider])).toThrow(
      "Duplicate",
    );
    const registry = new ConnectionProviderRegistry([provider]);
    const listed = registry.list();
    expect(listed).toEqual([provider]);
    expect(registry.get("fake")).toBe(provider);
  });
});

describe("connection aliases", () => {
  it("maps valid aliases without lossy normalization", () => {
    expect(connectionMcpServerName("google-workspace_admin")).toBe(
      "connection_google-workspace_admin",
    );
  });

  it("rejects aliases that could collide after normalization", () => {
    expect(() => assertConnectionAlias("google.workspace")).toThrow(
      "Invalid connection alias",
    );
    expect(() => connectionMcpServerName("google/workspace")).toThrow(
      "Invalid connection alias",
    );
  });
});
