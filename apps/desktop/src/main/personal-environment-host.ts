import {
  type PersonalEnvironmentLink,
  PersonalEnvironmentSync,
} from "./personal-environment-sync.js";
import type { ProfileConfigManager } from "./profile-config.js";
import type { ProfilesStore } from "./profiles.js";
import { refreshRemoteCredentials } from "./remote-oauth.js";
import { httpDocumentsClient } from "./remote-sync.js";

/**
 * The desktop's remote environment sync (ADR 0184): every profile's linked
 * projects and the files each lists. Sign-ins stay on this machine (ADR
 * 0199).
 */
export function desktopPersonalEnvironment(deps: {
  profiles: ProfilesStore;
  profileConfig: ProfileConfigManager;
  projectRoot: (projectId: string) => Promise<string | null>;
}): PersonalEnvironmentSync {
  const links = (): PersonalEnvironmentLink[] =>
    deps.profiles.list().profiles.flatMap((profile) => {
      const store = deps.profileConfig.forProfile(profile.id).remoteProjects;
      return Object.entries(store.list()).map(([localProjectId, link]) => ({
        profileId: profile.id,
        localProjectId,
        serverUrl: link.serverUrl,
        client: store.inspect(localProjectId)?.credentials
          ? httpDocumentsClient({
              serverUrl: link.serverUrl,
              projectId: link.remoteProjectId,
              accessToken: (forceRefresh) =>
                store.accessToken(localProjectId, {
                  ...(forceRefresh ? { forceRefresh } : {}),
                  refresh: (credentials) =>
                    refreshRemoteCredentials({ credentials }),
                }),
            })
          : null,
      }));
    });
  return new PersonalEnvironmentSync({ links, projectRoot: deps.projectRoot });
}
