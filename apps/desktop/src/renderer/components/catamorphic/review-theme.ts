import { registerCustomCSSVariableTheme } from "@pierre/diffs";

/** Syntax stays tokenized while CSS follows the embedding host's live palette. */
export const REVIEW_CODE_THEME = "catamorphic-review";
registerCustomCSSVariableTheme(REVIEW_CODE_THEME, {
  foreground: "var(--color-fg)",
  background: "var(--color-bg)",
  "token-comment": "var(--color-fg-muted)",
  "token-keyword": "var(--color-accent)",
  "token-string": "var(--color-success)",
  "token-string-expression": "var(--color-success)",
  "token-constant": "var(--color-warning)",
  "token-function": "var(--color-info)",
  "token-parameter": "var(--color-fg)",
  "token-punctuation": "var(--color-fg-muted)",
  "token-link": "var(--color-accent)",
});

/** These variables cross the diff's shadow root without a theme observer. */
export const reviewCodeCss = `:host {
  --diffs-font-family: var(--font-mono, monospace);
  --diffs-header-font-family: var(--font-sans, system-ui);
  --diffs-font-size: var(--cat-font-size, 13px);
  --diffs-line-height: calc(var(--cat-font-size, 13px) * 1.55);
}`;

export const reviewCodeThemeCss = `:host {
  --diffs-fg-number-override: var(--color-fg-faint);
  --diffs-bg-buffer-override: var(--color-bg-inset);
  --diffs-bg-context-override: var(--color-bg-raised);
  --diffs-bg-context-gutter-override: var(--color-bg-raised);
  --diffs-bg-separator-override: var(--color-bg-overlay);
  --diffs-bg-hover-override: var(--color-bg-overlay);
  --diffs-addition-color-override: var(--color-success);
  --diffs-deletion-color-override: var(--color-danger);
  --diffs-modified-color-override: var(--color-accent);
}`;
