import type { ITheme } from "ghostty-web";

/** Portable appearance values supported by the embedded terminal renderer. */
export interface TerminalAppearance {
  name: string;
  fontFamily: string;
  fontSize: number;
  theme: ITheme;
}

export type TerminalAppearanceResult =
  | { ok: true; appearance: TerminalAppearance }
  | { ok: false; error: string };
