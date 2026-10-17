/**
 * Written to a terminal view once it is created and sized: cursor home,
 * erase the screen. ghostty-web's terminals share one WASM heap, and a new
 * one is handed memory a closed one used without it being zeroed, so every
 * cell the new terminal had not written yet showed the old terminal's
 * text, sheared to the new width. Erasing makes every cell its own; rows
 * that scroll in or come with a resize afterwards arrive blank.
 */
export const FRESH_SCREEN = "\x1b[H\x1b[2J";
