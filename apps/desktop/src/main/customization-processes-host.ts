import path from "node:path";
import { safeStorage } from "electron";
import { accessBeyond, isEmptyAccess } from "../shared/code-access.js";
import { CodeApprovals } from "./code-approvals.js";
import { credentialEncryptionAvailableAsync } from "./credential-encryption.js";
import { CustomizationProcesses } from "./customization-processes.js";
import { isLoopback } from "./egress-proxy.js";
import { moduleAccessSubject, readModuleAccess } from "./module-access.js";
import { launchConfinedModule } from "./module-sandbox.js";
import type { ProfileConfigManager } from "./profile-config.js";
import type { ProfilesStore } from "./profiles.js";

/** Host adapter shared by the foreground and the headless Work engine. */
export function desktopCustomizationProcesses(input: {
  root: string;
  profilesDir: string;
  profiles: ProfilesStore;
  config: ProfileConfigManager;
  rootFor: (projectId: string) => Promise<string | null>;
  toolchain: () => Promise<Record<string, string>>;
  workPorts: () => number[];
  projects: () => Promise<string[]>;
  readState: (
    projectId: string,
  ) => Promise<{ version: number; value: unknown }>;
  writeState: ConstructorParameters<
    typeof CustomizationProcesses
  >[0]["writeState"];
}) {
  const approvals = new Map<string, CodeApprovals>();
  const approvalsFor = (profileId: string) => {
    let store = approvals.get(profileId);
    if (!store) {
      store = new CodeApprovals({
        dir: path.join(input.profilesDir, profileId),
        keyring: {
          available: () => credentialEncryptionAvailableAsync(),
          encrypt: (text) => safeStorage.encryptStringAsync(text),
          decrypt: async (data) =>
            (await safeStorage.decryptStringAsync(data)).result,
        },
      });
      approvals.set(profileId, store);
    }
    return store;
  };
  const ownerApprovals = (owner: { profileId: string; projectId: string }) => {
    // Registry data is untrusted before authentication. Never use its profile
    // string as a filesystem path or ask another profile's keyring for a key.
    if (
      !input.profiles.get(owner.profileId) ||
      input.profiles.profileForProject(owner.projectId).id !== owner.profileId
    )
      throw new Error(
        "This service registry entry belongs to another profile.",
      );
    return approvalsFor(owner.profileId);
  };
  return new CustomizationProcesses({
    ...input,
    seal: ({ definition, stateVersion }) =>
      ownerApprovals(definition.owner).sealServiceDefinition({
        payload: JSON.stringify([stateVersion, definition]),
      }),
    verify: ({ definition, stateVersion, signature }) =>
      ownerApprovals(definition.owner).verifyServiceDefinition({
        payload: JSON.stringify([stateVersion, definition]),
        signature,
      }),
    authorize: async (owner, lifetime) => {
      if (
        !input.profiles.get(owner.profileId) ||
        input.profiles.profileForProject(owner.projectId).id !== owner.profileId
      )
        throw new Error("This background service belongs to another profile.");
      if (
        input.config
          .forProfile(owner.profileId)
          .remoteProjects.inspect(owner.projectId)
      )
        throw new Error(
          "Private background services run only in local projects.",
        );
      const projectRoot = await input.rootFor(owner.projectId);
      if (!projectRoot)
        throw new Error(
          "This background service needs a local project folder.",
        );
      const declaration = readModuleAccess({
        projectRoot,
        modulePath: owner.modulePath,
      });
      const subject = moduleAccessSubject({
        projectId: owner.projectId,
        projectRoot,
        modulePath: owner.modulePath,
        declaration,
      });
      const access = declaration.access;
      if (
        !access.permissions?.includes("processes") ||
        (lifetime === "application" &&
          !access.permissions.includes("background"))
      )
        throw new Error(
          "This package needs processes access, and background access for application services.",
        );
      if (
        !isEmptyAccess(
          accessBeyond(
            await approvalsFor(owner.profileId).approved(subject, {
              refresh: true,
            }),
            access,
          ),
        )
      )
        throw new Error(
          "This background service needs approval for its current package access.",
        );
      return { subject, projectRoot, access };
    },
    launch: async ({ owner, workerPath, access, projectRoot, scope }) => {
      const toolchain = await input.toolchain();
      return launchConfinedModule({
        executable: toolchain.CATAMORPHIC_BUN ?? "bun",
        workerPath,
        modulePath: owner.modulePath,
        projectRoot,
        access,
        toolchain,
        scratchRoot: path.join(input.root, "scratch"),
        scope,
        // Actual background services are confined even under E2E. Tests of the
        // manager alone inject a launch adapter; packaged behavior has no bypass.
        blocked: (host, port) =>
          isLoopback(host) && input.workPorts().includes(port),
      });
    },
    onError: (error) =>
      console.warn("[desktop] Background service could not run:", error),
  });
}
