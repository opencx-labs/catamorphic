import { FitAddon, init as initGhostty, Terminal } from "ghostty-web";
import { useEffect, useRef } from "react";
import { KEYBINDING_ACTIONS } from "../../shared/actions.js";
import {
  desktopApi,
  type ResolvedTheme,
  type ThemeColors,
} from "../lib/desktop-api.js";
import { matchesBinding, useKeybindings } from "../lib/keybindings.js";
import { sanitizeScrollback } from "../lib/scrollback.js";
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
  /**
   * Attach to an existing PTY session (an agent-spawned terminal)
   * instead of creating one: history replays from the main-side buffer
   * and output streams live. The session is NOT killed on unmount.
   */
  attachSessionId?: string;
  /**
   * Reopened tab (Cmd+Shift+T): replay the closed session's scrollback,
   * close it with a divider, and start the fresh shell beneath — the
   * user may still have wanted to read that output.
   */
  restoreSessionId?: string;
  /** Viewing only — keystrokes don't reach the PTY (agent in control). */
  readOnly?: boolean;
  /** Shell title changes (OSC 0/2) — feeds the tab label. */
  onTitle: (title: string) => void;
  /** The shell exited (Ctrl+D, `exit`) — the tab closes itself. */
  onExit: () => void;
  /**
   * Reports the PTY session backing this tab. The workspace records it so
   * agents can read what any terminal shows (main keeps a rolling buffer
   * per session).
   */
  onSession?: (sessionId: string) => void;
}

export function TerminalScreen({
  projectId,
  active,
  attachSessionId,
  restoreSessionId,
  readOnly = false,
  onTitle,
  onExit,
  onSession,
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
  const onSessionRef = useRef(onSession);
  onSessionRef.current = onSession;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
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
          if (
            KEYBINDING_ACTIONS.some((action) =>
              matchesBinding(event, bindings[action]),
            )
          ) {
            return true;
          }
          // Cmd+D closes this terminal: kill the shell — the exit event
          // closes the tab (and the scrollback is buried for ⌘⇧T). Not
          // for agent-owned terminals; those close through their chat.
          if (
            event.type === "keydown" &&
            event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.shiftKey &&
            event.code === "KeyD"
          ) {
            if (sessionId && !readOnlyRef.current && !attachSessionId) {
              void desktopApi.terminalKill(sessionId);
            }
            return true;
          }
          // Unbound Cmd-combos must never reach the encoder: libghostty's
          // legacy encoding drops the super modifier and would TYPE the
          // plain letter into the shell (Cmd+D → "d"). Swallow them like
          // a real terminal does — except Cmd+C/Cmd+V, which ghostty's
          // own handler turns into copy/paste.
          if (
            event.metaKey &&
            !(event.code === "KeyC" || event.code === "KeyV")
          ) {
            return true;
          }
          return false;
        });
        fit = new FitAddon();
        term.loadAddon(fit);
        fit.fit();
        fit.observeResize();

        if (attachSessionId) {
          // Attach to the agent's live session: replay, then stream. The
          // shared PTY snaps to this view's geometry (tmux-attach style) —
          // the shell redraws on SIGWINCH, cleaning up replay wrapping.
          sessionId = attachSessionId;
          const history = await desktopApi.terminalBuffer(attachSessionId);
          if (disposed) return;
          if (history?.buffer) term.write(history.buffer);
          void desktopApi.terminalResize(attachSessionId, term.cols, term.rows);
        } else {
          // Reopened tab: the dead session's scrollback prints first —
          // sanitized to plain text (raw ANSI replay is grid-state
          // dependent and eats lines) and dimmed as a whole to read as
          // history — closed by a divider; the fresh shell prompts
          // beneath it.
          if (restoreSessionId) {
            const dead =
              await desktopApi.terminalRestoreBuffer(restoreSessionId);
            if (disposed) return;
            const lines = dead ? sanitizeScrollback(dead.buffer) : [];
            if (lines.length > 0) {
              term.write(
                `\x1b[2m${lines.join("\r\n")}\r\n── session ended · new shell ──\x1b[0m\r\n`,
              );
            }
          }
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
        }
        onSessionRef.current?.(sessionId);

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
        // outline while the terminal is unfocused. Read-only terminals
        // (agent-owned, before Take control) stay hollow even when
        // focused — a blinking cursor promises typing that won't land.
        let focused = true;
        const canType = () => focused && !readOnlyRef.current;
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
            if (canType()) {
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
            if (canType()) term?.renderer?.setCursorBlink(true);
          }, 600);
        };
        unsubscribes.push(() => window.clearTimeout(blinkTimer));
        // Focus lands on different elements depending on how it arrived:
        // term.focus() and tab-focus hit the contenteditable container,
        // canvas clicks hit the hidden clipboard textarea. focusin/focusout
        // on the container cover both (they bubble from descendants).
        {
          const onFocusIn = () => {
            focused = true;
            term?.renderer?.setCursorBlink(canType());
          };
          const onFocusOut = (event: FocusEvent) => {
            // Focus hopping between the container and its textarea (the
            // copy/paste flow) is not a blur.
            if (container.contains(event.relatedTarget as Node | null)) return;
            focused = false;
            window.clearTimeout(blinkTimer);
            // Steady hollow: no blink while unfocused.
            term?.renderer?.setCursorBlink(false);
          };
          container.addEventListener("focusin", onFocusIn);
          container.addEventListener("focusout", onFocusOut);
          unsubscribes.push(() => {
            container.removeEventListener("focusin", onFocusIn);
            container.removeEventListener("focusout", onFocusOut);
          });
          focused = container.contains(document.activeElement);
          if (!canType()) term.renderer?.setCursorBlink(false);
        }
        // Double/triple-click selection must anchor on the PRESS, not the
        // release (the xterm behavior): the word/line highlights on the
        // second/third mousedown and DRAGGING extends the selection by
        // word/line granularity. ghostty-web only selects inside its
        // `click` handler (which fires at mouseup), so double-click-drag
        // and triple-click-drag were impossible. Implemented against the
        // library's SelectionManager the same way the hollow cursor
        // shadows the renderer: feature-checked internals, and a changed
        // library silently degrades to stock behavior.
        interface SelectionPoint {
          col: number;
          absoluteRow: number;
        }
        interface SelectionManagerInternals {
          selectionStart: SelectionPoint | null;
          selectionEnd: SelectionPoint | null;
          isSelecting: boolean;
          pixelToCell(x: number, y: number): { col: number; row: number };
          viewportRowToAbsolute(row: number): number;
          getWordAtCell(
            col: number,
            row: number,
          ): { startCol: number; endCol: number } | null;
          markCurrentSelectionDirty(): void;
          requestRender(): void;
          selectionChangedEmitter?: { fire(): void };
        }
        const selection = (
          term as unknown as { selectionManager?: SelectionManagerInternals }
        ).selectionManager;
        const wasmTerm = (
          term as unknown as {
            wasmTerm?: { hasMouseTracking?: () => boolean };
          }
        ).wasmTerm;
        const canvas = container.querySelector("canvas");
        if (
          selection &&
          canvas &&
          typeof selection.pixelToCell === "function" &&
          typeof selection.viewportRowToAbsolute === "function" &&
          typeof selection.getWordAtCell === "function" &&
          typeof selection.markCurrentSelectionDirty === "function" &&
          typeof selection.requestRender === "function"
        ) {
          type Granularity = "word" | "line";
          let drag: {
            granularity: Granularity;
            anchorStart: SelectionPoint;
            anchorEnd: SelectionPoint;
          } | null = null;

          const cellAt = (clientX: number, clientY: number) => {
            const rect = canvas.getBoundingClientRect();
            const x = Math.max(rect.left, Math.min(clientX, rect.right));
            const y = Math.max(rect.top, Math.min(clientY, rect.bottom));
            return selection.pixelToCell(x - rect.left, y - rect.top);
          };
          /** The word/line bounds around a cell, in absolute-row space. */
          const unitAt = (
            granularity: Granularity,
            cell: { col: number; row: number },
          ): { start: SelectionPoint; end: SelectionPoint } => {
            const absoluteRow = selection.viewportRowToAbsolute(cell.row);
            if (granularity === "line") {
              return {
                start: { col: 0, absoluteRow },
                // Full width; getSelection trims trailing blanks per row.
                end: { col: Math.max(0, (term?.cols ?? 1) - 1), absoluteRow },
              };
            }
            const word = selection.getWordAtCell(cell.col, cell.row);
            return {
              start: { col: word?.startCol ?? cell.col, absoluteRow },
              end: { col: word?.endCol ?? cell.col, absoluteRow },
            };
          };
          const applySelection = (
            start: SelectionPoint,
            end: SelectionPoint,
          ) => {
            selection.markCurrentSelectionDirty();
            selection.selectionStart = start;
            selection.selectionEnd = end;
            // Our drag, not the library's — keep its machinery parked.
            selection.isSelecting = false;
            selection.requestRender();
          };
          const isBefore = (a: SelectionPoint, b: SelectionPoint) =>
            a.absoluteRow < b.absoluteRow ||
            (a.absoluteRow === b.absoluteRow && a.col < b.col);

          const onDragMove = (event: MouseEvent) => {
            if (!drag) return;
            const unit = unitAt(
              drag.granularity,
              cellAt(event.clientX, event.clientY),
            );
            // Extend past the anchor unit in either direction; inside it,
            // the selection stays the anchor word/line.
            if (isBefore(unit.start, drag.anchorStart)) {
              applySelection(unit.start, drag.anchorEnd);
            } else if (isBefore(drag.anchorEnd, unit.end)) {
              applySelection(drag.anchorStart, unit.end);
            } else {
              applySelection(drag.anchorStart, drag.anchorEnd);
            }
          };
          const onDragEnd = () => {
            if (!drag) return;
            drag = null;
            document.removeEventListener("mousemove", onDragMove);
            document.removeEventListener("mouseup", onDragEnd);
            // Copy-on-select, matching the library's own mouse selection.
            if (term?.hasSelection()) {
              term.copySelection();
              selection.selectionChangedEmitter?.fire();
            }
          };
          const onMultiPress = (event: MouseEvent) => {
            if (event.button !== 0 || event.detail < 2) return;
            // TUI apps that asked for mouse reporting get the raw
            // clicks; selection hijacking would break them.
            try {
              if (wasmTerm?.hasMouseTracking?.()) return;
            } catch {
              /* no tracking probe — treat as a plain shell */
            }
            // Capture phase on the container: this runs before the
            // library's canvas mousedown, which would otherwise reset
            // the selection to a single cell.
            event.preventDefault();
            event.stopPropagation();
            const granularity: Granularity =
              event.detail === 2 ? "word" : "line";
            const unit = unitAt(
              granularity,
              cellAt(event.clientX, event.clientY),
            );
            drag = {
              granularity,
              anchorStart: unit.start,
              anchorEnd: unit.end,
            };
            applySelection(unit.start, unit.end);
            term?.focus();
            document.addEventListener("mousemove", onDragMove);
            document.addEventListener("mouseup", onDragEnd);
          };
          // The library's own detail>=2 `click` handler fires at RELEASE
          // and would overwrite the drag-extended range with the word
          // under the release point — swallow multi-clicks outright.
          const onMultiClick = (event: MouseEvent) => {
            if (event.detail >= 2) event.stopPropagation();
          };
          container.addEventListener("mousedown", onMultiPress, {
            capture: true,
          });
          container.addEventListener("click", onMultiClick, { capture: true });
          unsubscribes.push(() => {
            container.removeEventListener("mousedown", onMultiPress, {
              capture: true,
            });
            container.removeEventListener("click", onMultiClick, {
              capture: true,
            });
            document.removeEventListener("mousemove", onDragMove);
            document.removeEventListener("mouseup", onDragEnd);
          });
        }
        term.onData((data) => {
          if (readOnlyRef.current) return;
          pinCursorWhileTyping();
          if (sessionId) void desktopApi.terminalWrite(sessionId, data);
        });
        // Resize is viewing geometry, not input — readOnly only blocks
        // keystrokes, so a watched agent terminal still fits this view.
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
      // Attached (agent) sessions outlive their view; owned ones die here.
      if (sessionId && !attachSessionId) {
        void desktopApi.terminalKill(sessionId);
      }
      fit?.dispose();
      term?.dispose();
      termRef.current = null;
    };
  }, [projectId, attachSessionId, restoreSessionId]);

  // Live theme edits restyle the running terminal.
  useEffect(() => {
    if (theme) termRef.current?.renderer?.setTheme(terminalTheme(theme.colors));
  }, [theme]);

  // Switching back to the tab lands keystrokes in the shell immediately.
  useEffect(() => {
    if (active) termRef.current?.focus();
  }, [active]);

  // Take control (readOnly → false) hands the keyboard over on the spot:
  // focus the terminal so the cursor goes solid and keys land. Going the
  // other way (agent reclaims), the cursor drops back to hollow.
  const wasReadOnlyRef = useRef(readOnly);
  useEffect(() => {
    const was = wasReadOnlyRef.current;
    wasReadOnlyRef.current = readOnly;
    const term = termRef.current;
    if (!term) return;
    if (was && !readOnly && active) {
      term.focus();
      // focus() won't refire focusin when already focused — arm the
      // blink explicitly.
      term.renderer?.setCursorBlink(true);
    }
    if (!was && readOnly) term.renderer?.setCursorBlink(false);
  }, [readOnly, active]);

  return (
    <div
      className="min-h-0 flex-1 overflow-hidden px-2 pt-2"
      style={{ backgroundColor: theme?.colors["bg-inset"] }}
    >
      {/* ghostty-web owns everything inside; the wrapper gives the
          FitAddon a measurable box and clips any canvas overshoot while
          a refit is pending (the container is contenteditable — without
          the clip, caret-into-view scrolling can shove ancestors). */}
      <div ref={containerRef} className="h-full w-full overflow-hidden" />
    </div>
  );
}
