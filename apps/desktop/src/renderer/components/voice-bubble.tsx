import { useAppPreferences } from "../lib/use-app-preferences.js";
import { VoiceButton } from "./voice-button.js";

/**
 * Voice's bubble (ADR 0236): the dock's microphone, on its own, floating
 * over other apps while voice is on and Work is not in front. The same
 * button and menu; the window never takes focus, so voice keeps writing
 * into the app in front.
 */
export function VoiceBubble() {
  const { prefs } = useAppPreferences();
  return (
    <div className="grid h-full place-items-center">
      <div className="rounded-full border border-border bg-bg-raised p-1.5 shadow-lg">
        <VoiceButton projectId={prefs.lastProjectId} bubble />
      </div>
    </div>
  );
}
