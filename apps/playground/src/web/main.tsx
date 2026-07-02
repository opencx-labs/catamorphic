import { createCatamorphicClient } from "@catamorphic/api-client";
import { CatamorphicProvider } from "@catamorphic/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import "@catamorphic/ui/styles.css";
import "./styles.css";

// Vite proxies `/api` to the playground server, which injects the demo
// identity headers — the browser never handles identity itself.
const apiClient = createCatamorphicClient({ baseUrl: "" });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CatamorphicProvider apiClient={apiClient}>
      <App />
    </CatamorphicProvider>
  </StrictMode>,
);
