import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CatamorphicAppProvider } from "@/components/catamorphic/catamorphic-provider.js";
import { App } from "./app.js";
import "@catamorphic/ui/styles.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CatamorphicAppProvider baseUrl="">
      <App />
    </CatamorphicAppProvider>
  </StrictMode>,
);
