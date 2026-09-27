import type { PersonalHarness } from "../shared/personal-environment.js";
import {
  type HarnessExecutable,
  harnessPathEnvironment,
} from "./harness-components.js";
import {
  readLocalLogin,
  refreshClaudeLogin,
  refreshCodexLogin,
} from "./harness-logins.js";
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
 * projects, the machine's own Claude Code and Codex logins, and the pinned
 * harness executables for local refreshes.
 */
export function desktopPersonalEnvironment(deps: {
  profiles: ProfilesStore;
  profileConfig: ProfileConfigManager;
  projectRoot: (projectId: string) => Promise<string | null>;
  ensureHarnessExecutable: (
    harness: PersonalHarness,
  ) => Promise<HarnessExecutable>;
  /** Automated tests never read or refresh the real logins. */
  isolated: boolean;
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
  return new PersonalEnvironmentSync({
    links,
    projectRoot: deps.projectRoot,
    readLogin: (harness) =>
      deps.isolated ? Promise.resolve(null) : readLocalLogin({ harness }),
    refreshLogin: async (harness) => {
      if (deps.isolated) return;
      const component = await deps.ensureHarnessExecutable(harness);
      const env = { ...process.env, ...harnessPathEnvironment(component) };
      if (harness === "codex") {
        // The machine login lives in ~/.codex, not an agent's own home.
        delete env.CODEX_HOME;
        await refreshCodexLogin({
          executablePath: component.executablePath,
          env,
        });
      } else
        await refreshClaudeLogin({
          executablePath: component.executablePath,
          env,
        });
    },
  });
}
