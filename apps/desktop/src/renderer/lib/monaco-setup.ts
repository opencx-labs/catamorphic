import { loader } from "@monaco-editor/react";
import { shikiToMonaco } from "@shikijs/monaco";
import * as monaco from "monaco-editor";
import { useEffect } from "react";
import { createHighlighter } from "shiki";
import { CODE_THEMES, resolveCodeTheme, useCodeTheme } from "./code-theme.js";
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

// Loaded once with the editor chunk; all grammars and themes ship locally.
const highlighting = createHighlighter({
  themes: CODE_THEMES.flatMap((name) => [
    resolveCodeTheme(name, true),
    resolveCodeTheme(name, false),
  ]),
  langs: [
    "typescript",
    "javascript",
    "tsx",
    "jsx",
    "json",
    "jsonc",
    "html",
    "css",
    "markdown",
    "yaml",
    "shellscript",
    "python",
    "sql",
    "rust",
    "go",
    "toml",
    "dockerfile",
  ],
}).then((highlighter) => {
  shikiToMonaco(highlighter, monaco);
});

export function useMonacoTheme() {
  const theme = useTheme();
  const [codeTheme] = useCodeTheme();
  const name = resolveCodeTheme(codeTheme, theme?.appearance === "light");
  useEffect(() => {
    let active = true;
    void highlighting.then(() => {
      if (active) monaco.editor.setTheme(name);
    });
    return () => {
      active = false;
    };
  }, [name]);
  return name;
}
