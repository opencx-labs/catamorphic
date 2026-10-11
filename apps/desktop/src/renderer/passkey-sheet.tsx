import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PasskeyHost } from "./components/passkey-sheet.js";
import { installFocusModality } from "./lib/focus-modality.js";
import { ThemeProvider } from "./lib/theme.js";
import "./styles.css";

/**
 * The passkey sheet alone, over a tab's sign-in popup (ADR 0220): a
 * transparent page in a view main lays over the popup's own, showing the
 * same sheet the workspace window shows over a tab.
 */
installFocusModality();
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider>
        <QueryClientProvider client={new QueryClient()}>
          <PasskeyHost />
        </QueryClientProvider>
      </ThemeProvider>
    </StrictMode>,
  );
