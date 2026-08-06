import { FitAddon, init as initGhostty, Terminal } from "ghostty-web";
import { useEffect, useRef } from "react";
import { KEYBINDING_ACTIONS } from "../../shared/actions.js";
import {
  desktopApi,
  type ResolvedTheme,
  type ThemeColors,
} from "../lib/desktop-api.js";
import { matchesBinding, useKeybindings } from "../lib/keybindings.js";
import { useTheme } from "../lib/theme.js";

/**
 * A terminal tab. Emulation runs in-process via ghostty-web — libghostty-vt
 * (Ghostty's VT parser/state core) compiled to WASM with a canvas renderer —
 * while the real PTY lives in main (see main/terminal.ts) and streams over
 * IPC. The component stays mounted while its tab is hidden; unmounting
 * kills the shell.
 */

// The WASM module is shared by every Terminal instance; load it once.
let ghosttyReady: Promise<void> | null = null;
const ensureGhostty = () => (ghosttyReady ??= initGhostty());

// Same face the rest of the app uses (styles.css --font-mono), spelled out
// because the canvas renderer measures a concrete font, not a CSS var.
const TERMINAL_FONT = '"JetBrains Mono", ui-monospace, "SF Mono", monospace';

/** App theme tokens → terminal colors. ANSI palette stays Ghostty's. */
const terminalTheme = (colors: ThemeColors) => ({
  background: colors["bg-inset"],
  foreground: colors.fg,
  cursor: colors.accent,
  selectionBackground: colors.accent,
  selectionForeground: colors["accent-fg"],
});

// Matches the browser tab's deferred mount: opening the (canvas-heavy)
// terminal mid tab-animation would stutter the slide-in.
const TAB_OPEN_ANIMATION_MS = 200;

export interface TerminalScreenProps {
  projectId: string;
  active: boolean;
  /** Shell title changes (OSC 0/2) — feeds the tab label. */
  onTitle: (title: string) => void;
  /** The shell exited (Ctrl+D, `exit`) — the tab closes itself. */
  onExit: () => void;
}

export function TerminalScreen({
  projectId,
  active,
  onTitle,
  onExit,
}: TerminalScreenProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const theme = useTheme();
  const keybindings = useKeybindings();
  const keybindingsRef = useRef(keybindings);
  keybindingsRef.current = keybindings;

  // Callbacks and theme live in refs so the one-shot setup effect below
  // never re-runs (recreating the terminal would kill the shell).
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const themeRef = useRef<ResolvedTheme | null>(theme);
  themeRef.current = theme;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let sessionId: string | null = null;
    const unsubscribes: (() => void)[] = [];

    const timer = window.setTimeout(() => {
      void (async () => {
        await ensureGhostty();
        if (disposed) return;
        const colors = themeRef.current?.colors;
        term = new Terminal({
          fontSize: 13,
          fontFamily: TERMINAL_FONT,
          cursorBlink: true,
          scrollback: 10_000,
          ...(colors ? { theme: terminalTheme(colors) } : {}),
        });
        term.open(container);
        termRef.current = term;
        // Chromium paints the hidden input textarea's caret even at
        // opacity 0 — without this a phantom caret blinks at the
        // terminal's top-left corner.
        if (term.textarea) term.textarea.style.caretColor = "transparent";
        // App shortcuts (Cmd+W, Cmd+T, Ctrl+`…) must beat the shell:
        // returning true skips PTY encoding AND skips the encoder path's
        // stopPropagation, so the event bubbles on to the window-level
        // shortcut dispatcher in app.tsx.
        term.attachCustomKeyEventHandler((event) => {
          const bindings = keybindingsRef.current;
          return KEYBINDING_ACTIONS.some((action) =>
            matchesBinding(event, bindings[action]),
          );
        });
        fit = new FitAddon();
        term.loadAddon(fit);
        fit.fit();
        fit.observeResize();

        const created = await desktopApi.terminalCreate({
          projectId,
          cols: term.cols,
          rows: term.rows,
        });
        if (disposed) {
          void desktopApi.terminalKill(created.sessionId);
          return;
        }
        sessionId = created.sessionId;

        unsubscribes.push(
          desktopApi.onTerminalData((payload) => {
            if (payload.sessionId === sessionId) term?.write(payload.data);
          }),
          desktopApi.onTerminalExit((payload) => {
            if (payload.sessionId !== sessionId) return;
            sessionId = null;
            onExitRef.current();
          }),
        );
        // Cursor states, native-terminal style: blinking solid block when
        // focused and idle, pinned solid while typing, and a steady hollow
        // outline while the terminal is unfocused.
        let focused = true;
        // ghostty-web has no hollow mode — shadow the renderer's
        // renderCursor: unfocused, repaint the cell (erasing the previous
        // solid block) and stroke the outline instead.
        interface CursorRendererInternals {
          renderCursor: (x: number, y: number) => void;
          ctx: CanvasRenderingContext2D;
          theme: { cursor: string; background: string };
          currentBuffer: {
            getLine: (row: number) => unknown[] | null;
          } | null;
          renderCellBackground: (cell: unknown, x: number, y: number) => void;
          renderCellText: (cell: unknown, x: number, y: number) => void;
        }
        const renderer = term.renderer as unknown as
          | (CursorRendererInternals & {
              getMetrics: () => { width: number; height: number };
            })
          | undefined;
        if (renderer) {
          const solidRenderCursor = renderer.renderCursor.bind(renderer);
          renderer.renderCursor = (x: number, y: number) => {
            if (focused) {
              solidRenderCursor(x, y);
              return;
            }
            const metrics = renderer.getMetrics();
            const px = x * metrics.width;
            const py = y * metrics.height;
            const ctx = renderer.ctx;
            ctx.save();
            // Erase whatever cursor was painted before, restore the cell.
            ctx.fillStyle = renderer.theme.background;
            ctx.fillRect(px, py, metrics.width, metrics.height);
            const cell = renderer.currentBuffer?.getLine(y)?.[x];
            if (cell) {
              try {
                renderer.renderCellBackground(cell, x, y);
                renderer.renderCellText(cell, x, y);
              } catch {
                // Cell repaint is cosmetic; the outline still lands.
              }
            }
            ctx.strokeStyle = renderer.theme.cursor;
            ctx.lineWidth = 1;
            ctx.strokeRect(
              px + 0.5,
              py + 0.5,
              metrics.width - 1,
              metrics.height - 1,
            );
            ctx.restore();
          };
        }
        // Typing pins the cursor solid; the blink resumes after a short
        // idle beat — unless the terminal blurred in the meantime.
        let blinkTimer: number | undefined;
        const pinCursorWhileTyping = () => {
          term?.renderer?.setCursorBlink(false);
          window.clearTimeout(blinkTimer);
          blinkTimer = window.setTimeout(() => {
            if (focused) term?.renderer?.setCursorBlink(true);
          }, 600);
        };
        unsubscribes.push(() => window.clearTimeout(blinkTimer));
        const input = term.textarea;
        if (input) {
          const onFocus = () => {
            focused = true;
            term?.renderer?.setCursorBlink(true);
          };
          const onBlur = () => {
            focused = false;
            window.clearTimeout(blinkTimer);
            // Steady hollow: no blink while unfocused.
            term?.renderer?.setCursorBlink(false);
          };
          input.addEventListener("focus", onFocus);
          input.addEventListener("blur", onBlur);
          unsubscribes.push(() => {
            input.removeEventListener("focus", onFocus);
            input.removeEventListener("blur", onBlur);
          });
          focused = document.activeElement === input;
          if (!focused) term.renderer?.setCursorBlink(false);
        }
        term.onData((data) => {
          pinCursorWhileTyping();
          if (sessionId) void desktopApi.terminalWrite(sessionId, data);
        });
        term.onResize(({ cols, rows }) => {
          if (sessionId) void desktopApi.terminalResize(sessionId, cols, rows);
        });
        term.onTitleChange((title) => onTitleRef.current(title));
        term.focus();
      })();
    }, TAB_OPEN_ANIMATION_MS);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      for (const unsubscribe of unsubscribes) unsubscribe();
      if (sessionId) void desktopApi.terminalKill(sessionId);
      fit?.dispose();
      term?.dispose();
      termRef.current = null;
    };
  }, [projectId]);

  // Live theme edits restyle the running terminal.
  useEffect(() => {
    if (theme) termRef.current?.renderer?.setTheme(terminalTheme(theme.colors));
  }, [theme]);

  // Switching back to the tab lands keystrokes in the shell immediately.
  useEffect(() => {
    if (active) termRef.current?.focus();
  }, [active]);

  return (
    <div
      className="min-h-0 flex-1 overflow-hidden px-2 pt-2"
      style={{ backgroundColor: theme?.colors["bg-inset"] }}
    >
      {/* ghostty-web owns everything inside; the wrapper just gives the
          FitAddon a measurable box. */}
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
