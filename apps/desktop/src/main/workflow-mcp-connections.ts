import type {
  CatamorphicCore,
  ConnectionProvider,
  Identity,
} from "@catamorphic/core";
import type { Json } from "@catamorphic/db";
import { connectMcpServer } from "@catamorphic/mcp";
import type { AgentMcpServerConfig } from "@catamorphic/sandbox";
import { connectionServerKey, toAgentMcpServer } from "./connections-store.js";
import type { ProfileConfigManager } from "./profile-config.js";
import type { ProfilesStore } from "./profiles.js";

export const DESKTOP_PROFILE_MCP_PROVIDER_KIND = "desktop-profile-mcp";

/** One dynamic provider is enough for every profile MCP server. */
export const desktopProfileMcpProvider: ConnectionProvider = {
  kind: DESKTOP_PROFILE_MCP_PROVIDER_KIND,
  displayName: "Desktop MCP connection",
  async listActions(input) {
    const server = await connectMcpServer(decodeServer(input.material));
    try {
      return server.tools
        .filter((tool) => input.capabilities.includes(tool.name))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: JSON.parse(JSON.stringify(tool.inputSchema)) as Json,
          ...(tool.annotations
            ? {
                annotations: JSON.parse(
                  JSON.stringify(tool.annotations),
                ) as Record<string, Json>,
              }
            : {}),
        }));
    } finally {
      await server.close().catch(() => {});
    }
  },
  async invoke(input) {
    if (!input.capabilities.includes(input.action)) {
      throw new Error(
        `MCP tool '${input.action}' is outside the connection grant`,
      );
    }
    const server = await connectMcpServer(decodeServer(input.material));
    try {
      const args =
        typeof input.input === "object" &&
        input.input !== null &&
        !Array.isArray(input.input)
          ? (input.input as Record<string, unknown>)
          : {};
      return JSON.parse(
        JSON.stringify(await server.callToolRaw(input.action, args)),
      ) as Json;
    } finally {
      await server.close().catch(() => {});
    }
  },
};

/**
 * Adopt profile MCP authorization into the ordinary connection broker. The
 * secret is copied only between two encrypted main-process stores; workflow
 * code and sandboxes receive aliases and capability names, never material.
 */
export async function syncProfileMcpWorkflowConnections(input: {
  core: CatamorphicCore;
  profiles: ProfilesStore;
  profileConfig: ProfileConfigManager;
  identity: Identity;
  profileId?: string;
}): Promise<void> {
  const service = input.core.connections;
  if (!service) return;
  const projects = await input.core.projects.list(input.identity, {
    limit: 500,
  });
  for (const project of projects.items) {
    const profile = input.profiles.profileForProject(project.id);
    if (input.profileId && profile.id !== input.profileId) continue;
    const configured = input.profileConfig
      .forProfile(profile.id)
      .connections.list()
      .filter(
        (connection) => connection.enabled && toAgentMcpServer(connection),
      );
    const existing = await service.list({
      identity: input.identity,
      projectId: project.id,
    });
    for (const connection of configured) {
      const server = toAgentMcpServer(connection);
      if (!server) continue;
      const account = {
        desktopProfileId: profile.id,
        desktopMcpConnectionId: connection.id,
        desktopMcpAlias: connectionServerKey(connection),
      };
      const current = existing.find(
        (candidate) =>
          candidate.projectId === project.id &&
          accountMarker(candidate.account, "desktopProfileId") === profile.id &&
          accountMarker(candidate.account, "desktopMcpConnectionId") ===
            connection.id,
      );
      const alias = connectionServerKey(connection);
      const previousAlias = current
        ? accountMarker(current.account, "desktopMcpAlias")
        : undefined;
      if (previousAlias && previousAlias !== alias) {
        await service.detachMember({
          identity: input.identity,
          projectId: project.id,
          environment: "local",
          alias: previousAlias,
        });
      }
      const material = new TextEncoder().encode(JSON.stringify(server));
      const capabilities = connection.tools?.map((tool) => tool.name) ?? [];
      const adopted = current
        ? await service.replaceMemberCredential({
            identity: input.identity,
            connectionId: current.id,
            material,
            account,
            capabilities,
          })
        : await service.create({
            identity: input.identity,
            projectId: project.id,
            providerKind: DESKTOP_PROFILE_MCP_PROVIDER_KIND,
            principalKind: "member",
            label: connection.name,
            material,
            account,
            capabilities,
          });
      await service.bind({
        identity: input.identity,
        projectId: project.id,
        environment: "local",
        alias,
        providerKind: DESKTOP_PROFILE_MCP_PROVIDER_KIND,
        principalKinds: ["member"],
        capabilities,
      });
      await service.attachMember({
        identity: input.identity,
        projectId: project.id,
        environment: "local",
        alias,
        connectionId: adopted.id,
      });
    }
    const configuredIds = new Set(
      configured.map((connection) => connection.id),
    );
    for (const connection of existing) {
      if (
        accountMarker(connection.account, "desktopProfileId") !== profile.id ||
        configuredIds.has(
          accountMarker(connection.account, "desktopMcpConnectionId") ?? "",
        ) ||
        connection.status === "revoked"
      ) {
        continue;
      }
      const alias = accountMarker(connection.account, "desktopMcpAlias");
      if (alias) {
        await service.detachMember({
          identity: input.identity,
          projectId: project.id,
          environment: "local",
          alias,
        });
      }
      await service.revoke({
        identity: input.identity,
        connectionId: connection.id,
      });
    }
  }
}

function decodeServer(material: Uint8Array): AgentMcpServerConfig {
  return JSON.parse(new TextDecoder().decode(material)) as AgentMcpServerConfig;
}

function accountMarker(account: Json, key: string): string | undefined {
  return typeof account === "object" &&
    account !== null &&
    !Array.isArray(account) &&
    typeof account[key] === "string"
    ? account[key]
    : undefined;
}
