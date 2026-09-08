import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { useLayoutEffect } from "react";
import { monacoTheme } from "./monaco-theme.js";
import { useTheme } from "./theme.js";
import "monaco-editor/languages/definitions/register.all";
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker?worker";

/**
 * Self-host Monaco: the packaged app has no network and the CSP blocks
 * the default CDN loader.
 *
 * Imported ONLY from the screens that actually render an editor (editor
 * tabs, workflow surfaces), which are themselves lazy-loaded — monaco is
 * ~half of the renderer bundle, and pulling it into the startup chunk
 * cost every launch a multi-hundred-ms parse for a feature many
 * sessions never open.
 */
self.MonacoEnvironment = {
  getWorker: (_workerId: string, label: string) =>
    label === "typescript" || label === "javascript"
      ? new tsWorker()
      : new editorWorker(),
};
loader.config({ monaco });

// This bridge stays in the lazy editor bundle. Theme changes never load Monaco
// in a workspace that has not opened an editor.
export function useMonacoTheme() {
  const theme = useTheme();
  useLayoutEffect(() => {
    if (!theme) return;
    monaco.editor.defineTheme("catamorphic", monacoTheme(theme));
    monaco.editor.setTheme("catamorphic");
  }, [theme]);
  return theme ? "catamorphic" : "vs-dark";
}
