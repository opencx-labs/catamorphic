import type { MenuItem } from "../../shared/menu.js";
import type {
  VoicePress,
  VoiceTarget,
  VoiceWindowChoice,
} from "../../shared/voice.js";

/**
 * The windows of Work's the bubble can talk to the assistant of, when
 * there is a choice: the one it talks to checked, all of them fixed once
 * the person has started talking.
 */
export function voiceWindowEntries(
  choices: readonly VoiceWindowChoice[],
): MenuItem[] {
  if (choices.length < 2) return [];
  return [
    {
      label: "Talk to the assistant of",
      action: "windows",
      disabledReason: "Pick a window below",
    },
    ...choices.map((choice): MenuItem => {
      const detail = [choice.assistant, choice.profile]
        .filter(Boolean)
        .join(" · ");
      const reason = choice.locked
        ? "You have started talking"
        : choice.assistant === null
          ? "That window's profile has no assistant yet"
          : null;
      return {
        label: choice.title,
        action: `window:${choice.id}`,
        checked: choice.current,
        ...(detail ? { detail } : {}),
        ...(reason ? { disabledReason: reason } : {}),
      };
    }),
  ];
}

/**
 * What a press of a microphone that shows a voice asks: that voice, so a
 * tap turns it off and a hold talks to it.
 */
export function voicePressFor(
  target: VoiceTarget,
  projectId: string | undefined,
) {
  const press: VoicePress =
    target.kind === "dictation"
      ? {
          action: "dictate",
          ...(target.sessionId ? { sessionId: target.sessionId } : {}),
        }
      : target.kind === "chat"
        ? {
            action: "talk-to-chat",
            projectId: target.projectId,
            sessionId: target.sessionId,
          }
        : { action: "talk-to-work", ...(projectId ? { projectId } : {}) };
  return press;
}
