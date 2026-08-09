import { describe, expect, it } from "vitest";
import { searchMcpRegistry, suggestConnection } from "../registry.js";

describe("suggestConnection", () => {
  it("prefers a streamable-http remote over sse and packages", () => {
    const suggested = suggestConnection({
      name: "com.example/server",
      remotes: [
        { type: "sse", url: "https://example.com/sse" },
        {
          type: "streamable-http",
          url: "https://example.com/mcp",
          headers: [
            {
              name: "Authorization",
              isRequired: true,
              isSecret: true,
              description: "Bearer token",
            },
          ],
        },
      ],
      packages: [{ registryType: "npm", identifier: "@example/server" }],
    });
    expect(suggested?.config).toEqual({
      transport: "http",
      url: "https://example.com/mcp",
    });
    expect(suggested?.inputs).toEqual([
      {
        name: "Authorization",
        kind: "header",
        description: "Bearer token",
        required: true,
        secret: true,
      },
    ]);
  });

  it("maps an npm package to an npx stdio command with pinned version", () => {
    const suggested = suggestConnection({
      name: "com.example/files",
      packages: [
        {
          registryType: "npm",
          identifier: "@example/files-server",
          version: "1.2.3",
          packageArguments: [
            { name: "root", type: "positional", value: "/data" },
          ],
          environmentVariables: [
            { name: "FILES_TOKEN", isRequired: true, isSecret: true },
          ],
        },
      ],
    });
    expect(suggested?.config).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@example/files-server@1.2.3", "/data"],
      env: { FILES_TOKEN: "" },
    });
    expect(suggested?.inputs).toEqual([
      {
        name: "FILES_TOKEN",
        kind: "env",
        description: undefined,
        required: true,
        secret: true,
      },
    ]);
  });

  it("returns undefined when nothing is installable", () => {
    expect(suggestConnection({ name: "com.example/empty" })).toBeUndefined();
  });
});

describe("searchMcpRegistry", () => {
  it("parses the v0.1 list shape and drops non-active entries", async () => {
    const fetchImpl = (async (url: URL | string | Request) => {
      expect(String(url)).toContain("/v0.1/servers?search=github");
      return new Response(
        JSON.stringify({
          servers: [
            {
              server: {
                name: "io.github.octo/github-server",
                description: "GitHub tools",
                version: "2.0.0",
                remotes: [
                  { type: "streamable-http", url: "https://gh.example/mcp" },
                ],
              },
              _meta: {
                "io.modelcontextprotocol.registry/official": {
                  status: "active",
                },
              },
            },
            {
              server: { name: "io.github.old/dead" },
              _meta: {
                "io.modelcontextprotocol.registry/official": {
                  status: "deprecated",
                },
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const entries = await searchMcpRegistry("github", { fetchImpl });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.displayName).toBe("github-server");
    expect(entries[0]?.suggested?.config).toEqual({
      transport: "http",
      url: "https://gh.example/mcp",
    });
  });
});
