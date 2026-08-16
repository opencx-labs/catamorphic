import { PluginKey } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";

/**
 * Build-time stub for @tiptap/y-tiptap and @tiptap/extension-collaboration,
 * aliased in electron.vite.config.ts. @tiptap/extension-drag-handle imports
 * both statically for its collaborative-cursor support, which would pull the
 * entire yjs graph (yjs, y-prosemirror, lib0 — ~50KB gzip) into the renderer
 * bundle for a feature we don't use.
 *
 * Safe because (verified against the pinned 3.30.1 dist):
 * - every y-tiptap function call is guarded by `ySyncPluginKey.getState(state)`
 *   being truthy, which requires a y-sync plugin we never register;
 * - `isChangeOrigin(tr)` without collaboration is exactly `false`.
 *
 * If tiptap is upgraded, re-verify those guards before keeping this stub.
 */

export const ySyncPluginKey = new PluginKey("cat-stubbed-y-sync");

export function isChangeOrigin(_tr: Transaction): boolean {
  return false;
}

function unreachable(): never {
  throw new Error(
    "tiptap-collab-stub: a y-tiptap function was called without a y-sync " +
      "plugin state — the stub's guard assumption no longer holds.",
  );
}

export function absolutePositionToRelativePosition(): never {
  return unreachable();
}

export function relativePositionToAbsolutePosition(): never {
  return unreachable();
}
