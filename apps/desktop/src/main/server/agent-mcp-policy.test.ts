import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveToolPermissionAcross } from "@catamorphic/sandbox";
import { afterEach, expect, it } from "vitest";
import { ProfileConfigManager } from "../profile-config.js";
import { ProfilesStore } from "../profiles.js";
import { DesktopAgentMcp } from "./agent-mcp-policy.js";
import type { DataPaths } from "./paths.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "settings-context-"));
  const paths: DataPaths = {
    root,
    db: `${root}/db`,
    projects: `${root}/projects`,
    remotes: `${root}/remotes`,
    appBundles: `${root}/apps`,
    githubFile: `${root}/github.json`,
    profilesFile: `${root}/profiles.json`,
    profilesDir: `${root}/profiles`,
    agentHomesDir: `${root}/agents`,
    harnessComponentsDir: `${root}/harness`,
    hostSkillsDir: `${root}/skills`,
  };
  const profiles = new ProfilesStore(paths.profilesFile);
  const one = profiles.create("One"),
    two = profiles.create("Two");
  const config = new ProfileConfigManager(paths, profiles);
  cleanups.push(() => {
    config.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, config, one, two };
}
it("allows ordinary local connectors by default and honors explicit restrictions", () => {
  const { config, one } = fixture();
  const stores = config.forProfile(one.id);
  const agent = stores.agents.create({ harness: "codex" });
  const connection = stores.connections.create({
    name: "Tools",
    transport: "stdio",
    command: "example",
  });
  const mcp = new DesktopAgentMcp({ profileConfig: config });
  const permission = () => {
    const result = mcp.live({ config: agent, profileId: one.id });
    const layers = Object.values(result.policies)[0] ?? [];
    return resolveToolPermissionAcross(layers, "write_file", {});
  };
  expect(permission()).toBe("allow");
  stores.agents.update(agent.id, { mode: "edit" });
  expect(permission()).toBe("ask");
  stores.agents.update(agent.id, { mode: "full-access" });
  stores.connections.setToolPermission(connection.id, "write_file", "deny");
  expect(permission()).toBe("deny");
  const layers =
    Object.values(mcp.live({ config: agent, profileId: one.id }).policies)[0] ??
    [];
  expect(resolveToolPermissionAcross(layers, "other_write", {})).toBe("allow");
  stores.connections.setToolPolicy(connection.id, { default: "auto" });
  expect(permission()).toBe("ask");
});
it("keeps the assigned computer-use service native to Codex and preserves ceilings", () => {
  const { config, one } = fixture();
  const stores = config.forProfile(one.id);
  const connection = stores.connections.create({
    name: "Computer",
    transport: "stdio",
    command: "cua",
    ceiling: { source: "Host", policy: { default: "deny" } },
  });
  const agent = stores.agents.create({ harness: "codex" });
  const mcp = new DesktopAgentMcp({
    profileConfig: config,
    connectors: {
      listInstalled: () => [
        {
          name: "codex-computer-use",
          description: "",
          marketplace: "Installed Codex",
          path: "/plugins/cua",
          external: true,
          connectionIds: [connection.id],
        },
      ],
    },
  });
  const resolved = mcp.resolve({ config: agent, profileId: one.id });
  expect(Object.values(resolved.nativeServers ?? {})).toEqual([
    expect.objectContaining({
      command: "cua",
      defaultToolsApprovalMode: "approve",
    }),
  ]);
  expect(
    resolveToolPermissionAcross(
      Object.values(resolved.policies)[0] ?? [],
      "click",
      {},
    ),
  ).toBe("deny");
  expect(
    mcp.resolve({
      config: { ...agent, connections: { mode: "picked", connectionIds: [] } },
      profileId: one.id,
    }).nativeServers,
  ).toEqual({});
  expect(
    mcp.resolve({
      config: { ...agent, harness: "claude-code" },
      profileId: one.id,
    }).nativeServers,
  ).toEqual({});
});
