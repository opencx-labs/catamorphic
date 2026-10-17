import { useEffect, useRef, useState } from "react";
import type { VoiceBubbleState } from "../../shared/voice.js";
import { desktopApi } from "../lib/desktop-api.js";
import { ProjectTheme } from "../lib/theme.js";
import { VoiceButton } from "./voice-button.js";

const AWAY: VoiceBubbleState = {
  shown: false,
  profileId: null,
  projectId: null,
};

/**
 * Voice's bubble (ADR 0236): the dock's microphone, on its own, floating
 * over other apps while voice is on and Work is not in front. The same
 * button and menu; the window never takes focus, so voice keeps writing
 * into the app in front. It eases in and out as the main process shows
 * and hides it, and wears the colours of the window whose assistant it
 * talks to, changing with them when the person picks another.
 */
export function VoiceBubble() {
  const [state, setState] = useState<VoiceBubbleState>(AWAY);
  useEffect(() => {
    let told = false;
    const stop = desktopApi.onVoiceBubble((next) => {
      told = true;
      setState(next);
    });
    // As it starts: unless the main process has told it since.
    void desktopApi.voiceBubbleState().then((next) => {
      if (next && !told) setState(next);
    });
    return stop;
  }, []);
  // Another profile's voice: its settings, theme and status from now, read
  // once this page wears that profile's project.
  const read = useRef<string | null>(null);
  useEffect(() => {
    const previous = read.current;
    read.current = state.profileId;
    if (previous !== null && state.profileId !== previous)
      window.dispatchEvent(new Event("catamorphic:profile-refetch"));
  }, [state.profileId]);
  const projectId = state.projectId ?? undefined;
  return (
    <ProjectTheme
      projectId={projectId}
      profileId={state.profileId ?? undefined}
    >
      <div className="grid h-full place-items-center">
        <div
          className="voice-bubble rounded-full border border-border bg-bg-raised p-1.5 shadow-lg"
          data-shown={state.shown ? "" : undefined}
        >
          <VoiceButton projectId={projectId} bubble />
        </div>
      </div>
    </ProjectTheme>
  );
}
