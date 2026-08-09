import { describe, expect, it } from "vitest";
import {
  liftMcpServer,
  marketplaceJsonUrls,
  parseMarketplace,
} from "../marketplace.js";

describe("marketplaceJsonUrls", () => {
  it("expands owner/repo shorthand to the raw marketplace.json", () => {
    expect(marketplaceJsonUrls("anthropics/claude-plugins-official")).toEqual([
      "https://raw.githubusercontent.com/anthropics/claude-plugins-official/HEAD/.claude-plugin/marketplace.json",
    ]);
  });

  it("expands a github repo url and passes explicit json urls through", () => {
    expect(marketplaceJsonUrls("https://github.com/acme/plugins")).toEqual([
      "https://raw.githubusercontent.com/acme/plugins/HEAD/.claude-plugin/marketplace.json",
    ]);
    expect(
      marketplaceJsonUrls("https://plugins.acme.dev/marketplace.json"),
    ).toEqual(["https://plugins.acme.dev/marketplace.json"]);
  });
});

describe("parseMarketplace", () => {
  it("normalizes relative, github, and git-subdir sources", () => {
    const entries = parseMarketplace("acme/plugins", {
      name: "acme",
      plugins: [
        { name: "local-one", description: "d", source: "./plugins/one" },
        {
          name: "external",
          source: { source: "github", repo: "acme/external-plugin" },
        },
        {
          name: "subdir",
          source: {
            source: "git-subdir",
            url: "https://github.com/acme/mono.git",
            path: "packages/plugin",
          },
        },
        { name: "broken", source: 42 },
      ],
    });
    expect(entries.map((entry) => entry.name)).toEqual([
      "local-one",
      "external",
      "subdir",
    ]);
    expect(entries[0]?.source).toEqual({
      kind: "git",
      url: "https://github.com/acme/plugins.git",
      subdir: "plugins/one",
    });
    expect(entries[1]?.source).toEqual({
      kind: "git",
      url: "https://github.com/acme/external-plugin.git",
    });
    expect(entries[2]?.source).toEqual({
      kind: "git",
      url: "https://github.com/acme/mono.git",
      subdir: "packages/plugin",
    });
  });
});

describe("liftMcpServer", () => {
  it("lifts remote servers with headers", () => {
    expect(
      liftMcpServer({
        type: "http",
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer x" },
      }),
    ).toEqual({
      transport: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer x" },
    });
  });

  it("lifts stdio servers and substitutes the plugin root", () => {
    expect(
      liftMcpServer(
        {
          command: "node",
          // biome-ignore-start lint/suspicious/noTemplateCurlyInString: the plugin spec's literal placeholder syntax
          args: ["${CLAUDE_PLUGIN_ROOT}/server/index.js"],
          env: { DATA_DIR: "${CLAUDE_PLUGIN_ROOT}/data" },
          // biome-ignore-end lint/suspicious/noTemplateCurlyInString: the plugin spec's literal placeholder syntax
        },
        "/plugins/acme",
      ),
    ).toEqual({
      transport: "stdio",
      command: "node",
      args: ["/plugins/acme/server/index.js"],
      env: { DATA_DIR: "/plugins/acme/data" },
    });
  });

  it("rejects malformed entries", () => {
    expect(liftMcpServer(null)).toBeUndefined();
    expect(liftMcpServer({ nonsense: true })).toBeUndefined();
  });
});
