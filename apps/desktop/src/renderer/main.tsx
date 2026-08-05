import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

// Self-host Monaco: the packaged app has no network and the CSP blocks the
// default CDN loader.
self.MonacoEnvironment = {
  getWorker: (_workerId: string, label: string) =>
    label === "typescript" || label === "javascript"
      ? new tsWorker()
      : new editorWorker(),
};
loader.config({ monaco });

import { App } from "./app.js";
import { CatamorphicAppProvider } from "./components/catamorphic/catamorphic-provider.js";
import { desktopApi, type ServerInfo } from "./lib/desktop-api.js";
import { KeybindingsProvider } from "./lib/keybindings.js";
import { ThemeProvider } from "./lib/theme.js";
import "@catamorphic/ui/styles.css";
import "./styles.css";

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

  if (!server?.url) {
    // Silent themed backdrop — the boot veil in App carries the reveal;
    // flashing a "Starting…" label first reads as flicker.
    return <div className="h-full bg-bg" />;
  }

  return (
    <CatamorphicAppProvider key={server.url} baseUrl={server.url}>
      <KeybindingsProvider>
        <App />
      </KeybindingsProvider>
    </CatamorphicAppProvider>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    {/* Outside Root: the theme must cover the pre-server "Starting…" state. */}
    <ThemeProvider>
      <Root />
    </ThemeProvider>
  </StrictMode>,
);
