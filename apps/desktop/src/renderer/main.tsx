import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

// Monaco deliberately does NOT load here — lib/monaco-setup.ts runs from
// the lazy editor/workflow chunks, keeping ~half the bundle off the
// startup path.

import { CatamorphicAppProvider } from "./components/catamorphic/catamorphic-provider.js";
import { DockHost } from "./components/dock-host.js";
import { ResourceLinkBoundary } from "./components/open-resource-button.js";
import { PasskeyHost } from "./components/passkey-sheet.js";
import { VoiceBubble, VoiceSpots } from "./components/voice-bubble.js";
import { desktopApi, type ServerInfo } from "./lib/desktop-api.js";
import { installFieldDictation } from "./lib/field-dictation.js";
import { installFocusModality } from "./lib/focus-modality.js";
import { installInertSelectionGuard } from "./lib/inert-selection.js";
import { KeybindingsProvider } from "./lib/keybindings.js";
import { workQueryClient } from "./lib/query-client.js";
import { useSessionChangeHints } from "./lib/session-change-hints.js";
import { TerminalAppearanceProvider } from "./lib/terminal-appearance.js";
import { ThemeProvider } from "./lib/theme.js";
import { WorkspaceRoot } from "./workspace-root.js";
import "./styles.css";
import "./lib/dev-performance.js";

const surface = new URLSearchParams(location.search).get("surface");
const detachedWindow = surface === "dock";
// The passkey sheet alone, over a browsing window that is not a tab (a
// tab's sign-in popup, ADR 0220): a transparent view main lays over the
// window's page, showing the same sheet the workspace shows over a tab.
const passkeySheet = surface === "passkey";
// Voice's bubble alone, over other apps while Work is behind them, and
// where it can rest while it is dragged.
const voiceBubble = surface === "voice";
const voiceSpots = surface === "bubble-spots";
document.documentElement.dataset.surface = detachedWindow
  ? "dock"
  : passkeySheet
    ? "passkey"
    : voiceBubble
      ? "voice"
      : voiceSpots
        ? "bubble-spots"
        : "workspace";
installFocusModality();
installInertSelectionGuard();
// Dictation writes into the text field the person is in (voice).
installFieldDictation({
  fieldFocused: desktopApi.voiceFieldFocus,
  sent: desktopApi.voiceDictationSent,
  onWords: desktopApi.onVoiceDictation,
});

/** This window's chat lists follow this computer's hints (ADR 0229). */
function SessionChangeHints() {
  useSessionChangeHints();
  return null;
}

function Root() {
  const [server, setServer] = useState<ServerInfo | null>(null);

  useEffect(() => {
    let mounted = true;
    void desktopApi.getServerState().then((info) => {
      if (mounted && info.url) setServer(info);
    });
    const unsubscribe = desktopApi.onServerChanged((info) => setServer(info));
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  // One cache per server, as the provider below is one per server.
  const queryClient = useMemo(
    () => (server?.url ? workQueryClient() : null),
    [server?.url],
  );

  if (!server?.url || !queryClient) {
    // Silent themed backdrop — the boot veil in App carries the reveal;
    // flashing a "Starting…" label first reads as flicker.
    return <div className={detachedWindow ? "h-full" : "h-full bg-bg"} />;
  }

  return (
    <CatamorphicAppProvider
      key={server.url}
      baseUrl={server.url}
      queryClient={queryClient}
    >
      <SessionChangeHints />
      <KeybindingsProvider>
        <TerminalAppearanceProvider>
          <ResourceLinkBoundary>
            {detachedWindow ? <DockHost detachedWindow /> : <WorkspaceRoot />}
          </ResourceLinkBoundary>
        </TerminalAppearanceProvider>
      </KeybindingsProvider>
    </CatamorphicAppProvider>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    {/* Outside Root: the theme must cover the pre-server "Starting…" state. */}
    <ThemeProvider>
      {passkeySheet ? (
        <QueryClientProvider client={new QueryClient()}>
          <PasskeyHost />
        </QueryClientProvider>
      ) : voiceBubble ? (
        <KeybindingsProvider>
          <VoiceBubble />
        </KeybindingsProvider>
      ) : voiceSpots ? (
        <VoiceSpots />
      ) : (
        <Root />
      )}
    </ThemeProvider>
  </StrictMode>,
);
