import { Settings } from "lucide-react";
import { useEffect, useState } from "react";
import {
  desktopApi,
  type Profile,
  type ProfileConnection,
  type ProfilesData,
} from "../lib/desktop-api";
import { ConnectorIcon } from "./connector-icon";
import { ProfileAvatar } from "./profile-avatar";

/** Connections listed before the rest collapse into a count. */
const CONNECTIONS_SHOWN = 6;

/**
 * A profile's preview card: who it is (avatar, name, whether the app opens
 * with it) and what it connects to, with a way into its settings.
 */
export function ProfileInspector({
  profile,
  data,
  onOpenSettings,
}: {
  profile: Profile;
  data: ProfilesData;
  onOpenSettings: () => void;
}) {
  const connections = useProfileConnections(profile.id);
  const isDefault = profile.id === data.defaultProfileId;
  return (
    <div className="text-[12px] text-fg-muted" data-testid="profile-inspector">
      <header className="flex items-center gap-2.5 pb-2.5">
        <ProfileAvatar profile={profile} size="lg" />
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <h2 className="truncate text-[13px] font-semibold text-fg">
            {profile.name}
          </h2>
          {isDefault && (
            <span className="shrink-0 rounded bg-bg-raised px-1.5 py-px text-[10px] font-medium text-fg-muted">
              Default
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label={`Open settings for ${profile.name}`}
          className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted hover:bg-bg-raised hover:text-fg"
        >
          <Settings className="size-3.5" />
        </button>
      </header>

      <section className="border-t border-border pt-2">
        <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-faint">
          Connections
        </h3>
        {connections === "loading" ? (
          <ul aria-busy>
            <li className="flex h-7 items-center gap-2">
              <span className="size-5 animate-pulse rounded bg-bg-raised" />
              <span className="h-3 w-24 animate-pulse rounded bg-bg-raised">
                <span className="sr-only">Loading</span>
              </span>
            </li>
          </ul>
        ) : connections === "failed" ? (
          <p className="text-fg-faint">Unavailable</p>
        ) : connections.length === 0 ? (
          <p className="text-fg-faint">None yet</p>
        ) : (
          <>
            <ul>
              {connections.slice(0, CONNECTIONS_SHOWN).map((connection) => (
                <li
                  key={connection.name}
                  className="flex h-7 items-center gap-2 text-fg"
                >
                  <ConnectorIcon
                    iconUrl={connection.iconUrl}
                    url={connection.url}
                    name={connection.name}
                    size="sm"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {connection.name}
                  </span>
                </li>
              ))}
            </ul>
            {connections.length > CONNECTIONS_SHOWN && (
              <p className="pt-0.5 text-[11px] text-fg-faint">
                {connections.length - CONNECTIONS_SHOWN} more
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}

/** Loads on inspection: the card mounts only when it opens. */
function useProfileConnections(
  profileId: string,
): ProfileConnection[] | "loading" | "failed" {
  const [connections, setConnections] = useState<
    ProfileConnection[] | "loading" | "failed"
  >("loading");
  useEffect(() => {
    let current = true;
    setConnections("loading");
    desktopApi.profileConnections(profileId).then(
      (loaded) => {
        if (current) setConnections(loaded);
      },
      () => {
        if (current) setConnections("failed");
      },
    );
    return () => {
      current = false;
    };
  }, [profileId]);
  return connections;
}
