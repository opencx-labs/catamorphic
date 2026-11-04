import { type RefObject, useCallback, useEffect, useRef } from "react";
import type { ChatDraft } from "../../shared/desktop-workspace.js";
import type { ComposerInputHandle } from "../components/composer-input.js";
import { desktopApi } from "./desktop-api.js";

/** Persist the DOM's draft without acknowledging a save by rewriting it.
 * An initial read loses to any edit or broadcast received while it waits. */
export function useComposerDraft({
  localId,
  composer,
  onLoaded,
}: {
  localId: string;
  composer: RefObject<Pick<ComposerInputHandle, "snapshot" | "restore"> | null>;
  onLoaded?: (result: { saved: ChatDraft | null; superseded: boolean }) => void;
}) {
  const state = useRef({
    restoring: false,
    loaded: false,
    serial: "",
    revision: 0,
    pending: false,
  });
  const loaded = useRef(onLoaded);
  loaded.current = onLoaded;
  const publish = useCallback(() => {
    const current = state.current;
    if (current.restoring) return;
    const next = composer.current?.snapshot();
    if (!next) return;
    const serial = JSON.stringify(next);
    if (serial === current.serial) return;
    current.serial = serial;
    current.revision += 1;
    if (!current.loaded) {
      current.pending = true;
      return;
    }
    void desktopApi.dockDraftSet(localId, next);
  }, [localId, composer]);

  useEffect(() => {
    let live = true;
    const current = state.current;
    const revision = current.revision;
    const restore = (next: ChatDraft) => {
      const serial = JSON.stringify(next);
      if (serial === current.serial) return;
      current.serial = serial;
      current.revision += 1;
      current.restoring = true;
      try {
        composer.current?.restore(next);
      } finally {
        current.restoring = false;
      }
    };
    void desktopApi.dockDraftGet(localId).then((saved) => {
      if (!live) return;
      const superseded = revision !== current.revision;
      if (saved && !superseded) restore(saved);
      current.loaded = true;
      if (superseded && current.pending) {
        const next = composer.current?.snapshot();
        if (next) void desktopApi.dockDraftSet(localId, next);
      }
      current.pending = false;
      loaded.current?.({ saved, superseded });
    });
    const stop = desktopApi.onDockDraft((update) => {
      if (update.localId === localId) restore(update.draft);
    });
    return () => {
      live = false;
      stop();
    };
  }, [localId, composer]);
  return publish;
}
