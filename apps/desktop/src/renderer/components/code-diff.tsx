import type { ComponentProps } from "react";
import { CODE_THEMES, resolveCodeTheme } from "../lib/code-theme.js";
import { formatBinding, useKeybindings } from "../lib/keybindings.js";
import { useTheme } from "../lib/theme.js";
import { useAppPreferences } from "../lib/use-app-preferences.js";
import { DiffView } from "./diff-view.js";

type CodeDiffProps = Omit<
  ComponentProps<typeof DiffView>,
  "options" | "layout" | "wrap" | "onLayoutChange" | "onWrapChange" | "toolbar"
>;

/** Desktop adapter: reusable DiffView has no preference store or host API dependency. */
export function CodeDiff(props: CodeDiffProps) {
  const theme = useTheme();
  const bindings = useKeybindings();
  const { prefs, update, error } = useAppPreferences();
  const light = theme?.appearance === "light";
  return (
    <>
      {error && (
        <p role="alert" className="px-3 py-1 text-xs text-danger">
          {error}
        </p>
      )}
      <DiffView
        findShortcut={formatBinding(bindings["search-diff"]) || "Unbound"}
        {...props}
        options={{
          theme: resolveCodeTheme(prefs.codeTheme, light),
          themeType: light ? "light" : "dark",
        }}
        layout={prefs.diffLayout}
        wrap={prefs.diffWrap}
        onLayoutChange={(diffLayout) => void update({ diffLayout })}
        onWrapChange={(diffWrap) => void update({ diffWrap })}
        toolbar={
          <select
            aria-label="Code theme"
            value={prefs.codeTheme}
            onChange={(event) => {
              const codeTheme = CODE_THEMES.find(
                (name) => name === event.target.value,
              );
              if (codeTheme) void update({ codeTheme });
            }}
            className="field rounded-md px-2 py-1"
          >
            {CODE_THEMES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        }
      />
    </>
  );
}
