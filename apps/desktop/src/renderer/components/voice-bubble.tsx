import { useEffect, useRef, useState } from "react";
import type { VoiceBubbleState } from "../../shared/voice.js";
import {
  VOICE_BUBBLE_SIZE,
  type VoiceSpotsState,
} from "../../shared/voice-bubble.js";
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
  useProfileFollow(state.profileId);
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

/**
 * Where the bubble can rest, shown while it is dragged (ADR 0236): a ring
 * at each spot along the bottom of the screen, the one it would land on
 * lit, as the dock shows its resting spots. They ease in as the drag
 * starts and out as the bubble lands, in its colours. The window never
 * takes a click.
 */
export function VoiceSpots() {
  const [state, setState] = useState<VoiceSpotsState | null>(null);
  useEffect(() => {
    let told = false;
    const stop = desktopApi.onVoiceSpots((next) => {
      told = true;
      setState(next);
    });
    void desktopApi.voiceSpotsState().then((next) => {
      if (next && !told) setState(next);
    });
    return stop;
  }, []);
  useProfileFollow(state?.profileId ?? null);
  return (
    <ProjectTheme
      projectId={state?.projectId ?? undefined}
      profileId={state?.profileId ?? undefined}
    >
      <div
        aria-hidden="true"
        className="voice-bubble-spots relative size-full"
        data-shown={state?.shown || undefined}
      >
        {state?.slots.map(({ spot, left }) => (
          <span
            key={spot}
            className="absolute grid place-items-center"
            style={{
              left,
              top: state.top,
              width: VOICE_BUBBLE_SIZE,
              height: VOICE_BUBBLE_SIZE,
            }}
          >
            {/* The bubble's own size: its button, padding and border. */}
            <span
              data-voice-spot={spot}
              data-active={spot === state.target || undefined}
              className={`size-[50px] rounded-full border transition-[opacity,box-shadow,border-color,background-color] duration-150 ease-standard ${
                spot === state.target
                  ? "border-accent/70 bg-accent/10 opacity-100 shadow-[0_0_0_1px_var(--color-accent),0_0_18px_color-mix(in_srgb,var(--color-accent)_45%,transparent)]"
                  : "border-dashed border-border-strong/60 bg-bg-raised/40 opacity-70"
              }`}
            />
          </span>
        ))}
      </div>
    </ProjectTheme>
  );
}

/**
 * Another profile's voice: its settings, theme and status from now, read
 * once this page wears that profile's project.
 */
function useProfileFollow(profileId: string | null) {
  const read = useRef<string | null>(null);
  useEffect(() => {
    const previous = read.current;
    read.current = profileId;
    if (previous !== null && profileId !== null && profileId !== previous)
      window.dispatchEvent(new Event("catamorphic:profile-refetch"));
  }, [profileId]);
}
