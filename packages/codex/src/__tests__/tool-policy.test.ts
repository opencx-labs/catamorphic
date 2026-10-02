import { describe, expect, it } from "vitest";
import { codexToolFilter, mcpServersConfig } from "../config.js";

describe("Codex MCP tool policy", () => {
  it("hides only the tools a policy denies outright", () => {
    const layers = [
      {
        tools: {
          delete_channel: "deny" as const,
          post_message: "allow" as const,
        },
      },
    ];
    const annotations = {
      list_channels: { readOnlyHint: true },
      create_channel: { readOnlyHint: false },
    };
    expect(codexToolFilter(layers, annotations)).toEqual({
      disabled_tools: ["delete_channel"],
    });
    expect(codexToolFilter(undefined, annotations)).toEqual({});
    expect(
      codexToolFilter([{ default: "deny", tools: { x: "allow" } }], {
        y: {},
      }),
    ).toEqual({ disabled_tools: ["y"] });
  });

  it("makes every other tool on a policy server ask, so the runner decides", () => {
    expect(
      mcpServersConfig({
        servers: {
          "team.slack": {
            transport: "http",
            url: "https://mcp.example/slack",
            headers: { authorization: "Bearer grant" },
            defaultToolsApprovalMode: "approve",
          },
          files: { transport: "stdio", command: "files-mcp", args: ["--ro"] },
        },
        policies: { "team.slack": [{ tools: { delete_channel: "deny" } }] },
        annotations: {},
      }),
    ).toEqual({
      team_slack: {
        url: "https://mcp.example/slack",
        http_headers: { authorization: "Bearer grant" },
        disabled_tools: ["delete_channel"],
        default_tools_approval_mode: "prompt",
      },
      files: { command: "files-mcp", args: ["--ro"] },
    });
  });
});
