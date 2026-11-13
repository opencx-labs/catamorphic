import { type RefObject, useEffect } from "react";
import type { ComposerInputHandle } from "../components/composer-input.js";
import { desktopApi } from "./desktop-api.js";
import { FieldDictation } from "./field-dictation.js";

/** Reuse dictation's provisional span, leaving the person's typed draft intact. */
export function useVoiceTranscript(
  projectId: string,
  sessionId: string | null | undefined,
  composer: RefObject<ComposerInputHandle | null>,
) {
  useEffect(() => {
    const preview = new FieldDictation();
    let segment = 0;
    const clear = () => {
      const field = preview.showing;
      if (!field) return;
      preview.apply(field, { segment, text: "", final: true });
      preview.flush();
    };
    const unsubscribe = desktopApi.onVoiceTranscript((words) => {
      if (words.projectId !== projectId || words.sessionId !== sessionId)
        return;
      const field = composer.current?.element();
      if (!field) return;
      segment = words.segment;
      preview.apply(field, { ...words, text: words.final ? "" : words.text });
      if (words.final) preview.flush();
    });
    return () => {
      unsubscribe();
      clear();
    };
  }, [projectId, sessionId, composer]);
}
