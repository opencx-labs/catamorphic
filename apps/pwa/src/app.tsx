import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { InstallPromotion } from "./components/install-promotion.js";
import { connectLinkFromParams } from "./lib/connect-link.js";
import { navigate, type Route, routeDepth, useRoute } from "./lib/nav.js";
import { completeRemoteConnection } from "./lib/oauth-callback.js";
import { applyPairing, claimPairing } from "./lib/pairing.js";
import {
  activeProfile,
  connectionById,
  getState,
  usePwaState,
} from "./lib/store.js";
import {
  applyTheme,
  DEFAULT_RESOLVED_THEME,
  fetchProjectTheme,
} from "./lib/theme.js";
import { ChatScreen } from "./screens/chat-screen.js";
import {
  ConnectScreen,
  stashConnectError,
  stashPendingLink,
} from "./screens/connect-screen.js";
import { ProfilesScreen } from "./screens/profiles-screen.js";
import { ProjectsScreen } from "./screens/projects-screen.js";
import { SessionsScreen } from "./screens/sessions-screen.js";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: true },
  },
});

export function App() {
  const state = usePwaState();
  const route = useRoute();
  const profile = activeProfile(state);
  const [startupStatus, setStartupStatus] = useState<string | null>(null);

  // A remote OAuth callback carries a short-lived code; a desktop QR carries
  // a short-lived pairing code. Credential-free server/project locators are
  // safe to retain as ordinary invitation links.
  useEffect(() => {
    if (window.location.pathname === "/oauth/callback") {
      const callbackUrl = window.location.href;
      window.history.replaceState(null, "", "/");
      setStartupStatus("Finishing sign-in…");
      void completeRemoteConnection({
        callbackUrl,
        profileId: activeProfile(getState()).id,
      })
        .then((landing) => navigate(landing, { replace: true }))
        .catch((error: unknown) => {
          stashConnectError(
            error instanceof Error
              ? error.message
              : "Sign-in could not be completed.",
          );
          navigate({ kind: "connect" }, { replace: true });
        })
        .finally(() => setStartupStatus(null));
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const pairCode = params.get("pair");
    if (pairCode) {
      window.history.replaceState(null, "", window.location.pathname);
      setStartupStatus("Pairing…");
      void claimPairing(window.location.origin, pairCode)
        .then((claim) => {
          const landing = applyPairing(getState(), claim);
          navigate(landing, { replace: true });
        })
        .catch((error: unknown) => {
          stashConnectError(
            error instanceof Error ? error.message : "Pairing failed.",
          );
          navigate({ kind: "connect" }, { replace: true });
        })
        .finally(() => setStartupStatus(null));
      return;
    }
    const link = connectLinkFromParams(params);
    if (!link) return;
    stashPendingLink(link);
    window.history.replaceState(null, "", window.location.pathname);
    navigate({ kind: "connect" }, { replace: true });
  }, []);

  // The project's committed theme applies while you're inside it; root
  // screens use the default. Applied via CSS vars, so it's instant.
  const inProject = route.kind === "sessions" || route.kind === "chat";
  const themeConnectionId = inProject ? route.connectionId : null;
  const themeProjectId = inProject ? route.projectId : null;
  useEffect(() => {
    if (!themeConnectionId || !themeProjectId) {
      applyTheme(DEFAULT_RESOLVED_THEME);
      return;
    }
    const connection = connectionById(state, themeConnectionId);
    if (!connection) return;
    let cancelled = false;
    void fetchProjectTheme(connection, themeProjectId).then((theme) => {
      if (!cancelled) applyTheme(theme ?? DEFAULT_RESOLVED_THEME);
    });
    return () => {
      cancelled = true;
    };
  }, [themeConnectionId, themeProjectId, state]);

  // Push vs fade: deeper routes slide in like a native stack; lateral or
  // backward moves cross-fade (the platform back gesture already animates).
  const prevDepthRef = useRef(routeDepth(route));
  const [animation, setAnimation] = useState("");
  const routeKey = JSON.stringify(route);
  const prevKeyRef = useRef(routeKey);
  if (prevKeyRef.current !== routeKey) {
    prevKeyRef.current = routeKey;
    const depth = routeDepth(route);
    setAnimation(
      depth > prevDepthRef.current
        ? "animate-screen-push"
        : "animate-screen-fade",
    );
    prevDepthRef.current = depth;
  }

  if (startupStatus) {
    return (
      <div className="grid h-full place-items-center bg-bg">
        <p className="animate-pulse text-sm text-fg-muted" role="status">
          {startupStatus}
        </p>
      </div>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <ScreenFor
        key={routeKey}
        route={route}
        animation={animation}
        hasConnections={profile.connections.length > 0}
      />
      <InstallPromotion
        enabled={!startupStatus && profile.connections.length > 0}
      />
    </QueryClientProvider>
  );
}

function ScreenFor({
  route,
  animation,
  hasConnections,
}: {
  route: Route;
  animation: string;
  hasConnections: boolean;
}) {
  const state = usePwaState();
  switch (route.kind) {
    case "connect":
      return <ConnectScreen canGoBack={hasConnections} animation={animation} />;
    case "profiles":
      return <ProfilesScreen animation={animation} />;
    case "sessions":
    case "chat": {
      const connection = connectionById(state, route.connectionId);
      if (!connection) {
        // A stale URL (removed connection, another profile's link).
        return <ProjectsScreen animation={animation} />;
      }
      if (route.kind === "chat") {
        return (
          <ChatScreen
            connection={connection}
            projectId={route.projectId}
            sessionId={route.sessionId}
            queryClient={queryClient}
            animation={animation}
          />
        );
      }
      return (
        <SessionsScreen
          connection={connection}
          projectId={route.projectId}
          projectName={
            connection.projectId === route.projectId
              ? (connection.projectName ?? "Project")
              : "Project"
          }
          queryClient={queryClient}
          animation={animation}
        />
      );
    }
    default:
      return hasConnections ? (
        <ProjectsScreen animation={animation} />
      ) : (
        <ConnectScreen canGoBack={false} animation={animation} />
      );
  }
}
