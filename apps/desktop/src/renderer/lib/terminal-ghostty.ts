import { Ghostty } from "ghostty-web";

/**
 * A WASM instance of its own for each terminal. ghostty-web's terminals
 * otherwise share one heap, and a new terminal was handed memory a closed
 * one had used without it being zeroed: every cell the new terminal had not
 * written showed the old one's text, read at the new width, and so did the
 * rows a terminal grown taller gained. A fresh instance starts on zeroed
 * memory, for about a megabyte and a few milliseconds each.
 */
export function terminalGhostty(wasm?: string): Promise<Ghostty> {
  return Ghostty.load(wasm);
}
