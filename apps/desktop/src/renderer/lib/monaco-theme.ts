import type { editor } from "monaco-editor";
import type { ResolvedTheme } from "./desktop-api.js";

/** Monaco consumes the same resolved palette as the shell and embedded apps. */
export function monacoTheme(theme: ResolvedTheme): editor.IStandaloneThemeData {
  const c = theme.colors;
  const tint = (color: string, alpha: string) => `${color.slice(0, 7)}${alpha}`;
  return {
    base: theme.appearance === "light" ? "vs" : "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: c.fg.slice(1) },
      {
        token: "comment",
        foreground: c["fg-muted"].slice(1),
        fontStyle: "italic",
      },
      { token: "keyword", foreground: c.accent.slice(1) },
      { token: "string", foreground: c.success.slice(1) },
      { token: "number", foreground: c.warning.slice(1) },
      { token: "type", foreground: c.info.slice(1) },
    ],
    colors: {
      "editor.background": c.bg,
      "editor.foreground": c.fg,
      "editorLineNumber.foreground": c["fg-faint"],
      "editorLineNumber.activeForeground": c["fg-muted"],
      "editorCursor.foreground": c.accent,
      "editor.selectionBackground": tint(c.accent, "40"),
      "editor.inactiveSelectionBackground": tint(c.accent, "20"),
      "editor.selectionHighlightBackground": tint(c.accent, "18"),
      "editor.lineHighlightBackground": c["bg-raised"],
      "editorIndentGuide.background1": c.border,
      "editorIndentGuide.activeBackground1": c["border-strong"],
      "editorWhitespace.foreground": c["border-strong"],
      "editorGutter.background": c.bg,
      "editorBracketHighlight.foreground1": c.info,
      "editorBracketHighlight.foreground2": c.accent,
      "editorBracketHighlight.foreground3": c.success,
      "editorBracketHighlight.foreground4": c.warning,
      "editorBracketHighlight.foreground5": c.info,
      "editorBracketHighlight.foreground6": c.accent,
      "editorWidget.background": c["bg-overlay"],
      "editorWidget.foreground": c.fg,
      "editorWidget.border": c.border,
      "editorSuggestWidget.background": c["bg-overlay"],
      "editorSuggestWidget.foreground": c.fg,
      "editorSuggestWidget.selectedBackground": tint(c.accent, "30"),
      "editorHoverWidget.background": c["bg-overlay"],
      "editorHoverWidget.foreground": c.fg,
      "editorHoverWidget.border": c.border,
      "editorError.foreground": c.danger,
      "editorWarning.foreground": c.warning,
      "editorInfo.foreground": c.info,
      "diffEditor.insertedTextBackground": tint(c.success, "30"),
      "diffEditor.removedTextBackground": tint(c.danger, "30"),
      "diffEditor.insertedLineBackground": tint(c.success, "14"),
      "diffEditor.removedLineBackground": tint(c.danger, "14"),
      "scrollbarSlider.background": tint(c["fg-faint"], "40"),
      "scrollbarSlider.hoverBackground": tint(c["fg-faint"], "70"),
      "scrollbarSlider.activeBackground": tint(c["fg-muted"], "70"),
      focusBorder: c.accent,
    },
  };
}
