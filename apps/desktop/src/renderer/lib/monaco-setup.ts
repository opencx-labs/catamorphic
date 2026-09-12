import { loader } from "@monaco-editor/react";
import { shikiToMonaco } from "@shikijs/monaco";
import * as monaco from "monaco-editor";
import { useEffect, useState } from "react";
import { createHighlighter } from "shiki";
import { CODE_THEMES, resolveCodeTheme, useCodeTheme } from "./code-theme.js";
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

// Shiki installs wrappers around these methods. Re-registration after a host
// theme change replaces that bridge instead of accumulating wrapper chains.
const nativeCreate = monaco.editor.create;
const nativeSetTheme = monaco.editor.setTheme;
function installHighlighting(
  highlighter: Awaited<ReturnType<typeof createHighlighter>>,
) {
  monaco.editor.create = nativeCreate;
  monaco.editor.setTheme = nativeSetTheme;
  shikiToMonaco(highlighter, monaco);
}

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
  installHighlighting(highlighter);
  return highlighter;
});

export function useMonacoTheme() {
  const theme = useTheme();
  const [codeTheme] = useCodeTheme();
  const [installed, setInstalled] = useState<string | null>(null);
  const baseName = resolveCodeTheme(codeTheme, theme?.appearance === "light");
  const signature = JSON.stringify(theme?.colors ?? {});
  const name = `catamorphic-${baseName}-${Array.from(signature).reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 0) >>> 0}`;
  useEffect(() => {
    let active = true;
    void highlighting.then(async (highlighter) => {
      if (!active || !theme) return;
      if (!highlighter.getLoadedThemes().includes(name)) {
        const base = highlighter.getTheme(baseName);
        const c = theme.colors;
        await highlighter.loadTheme({
          ...base,
          name,
          fg: c.fg,
          bg: c.bg,
          colors: { ...base.colors, ...monacoTheme(theme).colors },
          settings: [
            { settings: { foreground: c.fg, background: c.bg } },
            ...base.settings
              .filter((rule) => rule.scope)
              .flatMap((rule) =>
                (Array.isArray(rule.scope)
                  ? rule.scope
                  : [rule.scope ?? ""]
                ).map((scope) => {
                  const foreground = /comment/.test(scope)
                    ? c["fg-muted"]
                    : /keyword|storage/.test(scope)
                      ? c.accent
                      : /string/.test(scope)
                        ? c.success
                        : /constant/.test(scope)
                          ? c.warning
                          : /entity.name|support/.test(scope)
                            ? c.info
                            : c.fg;
                  return {
                    ...rule,
                    scope,
                    settings: { ...rule.settings, foreground },
                  };
                }),
              ),
            {
              scope: ["comment", "punctuation.definition.comment"],
              settings: { foreground: c["fg-muted"], fontStyle: "italic" },
            },
            {
              scope: ["keyword", "storage.type", "storage.modifier"],
              settings: { foreground: c.accent },
            },
            { scope: ["string"], settings: { foreground: c.success } },
            {
              scope: ["constant.numeric", "constant.language"],
              settings: { foreground: c.warning },
            },
            {
              scope: [
                "entity.name.type",
                "support.type",
                "entity.name.function",
              ],
              settings: { foreground: c.info },
            },
            {
              scope: [
                "variable",
                "meta.object-literal.key",
                "support.type.property-name.json",
              ],
              settings: { foreground: c.fg },
            },
          ],
        });
        installHighlighting(highlighter);
      }
      if (active) {
        monaco.editor.setTheme(name);
        setInstalled(name);
      }
    });
    return () => {
      active = false;
    };
  }, [baseName, name, theme]);
  return installed ?? baseName;
}
