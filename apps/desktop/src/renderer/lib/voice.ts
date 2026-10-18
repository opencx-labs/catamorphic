import type { VoicePress } from "../../shared/voice.js";
import { desktopApi } from "./desktop-api.js";

/**
 * A tap of a voice shortcut or microphone (ADR 0236): voice on there, or
 * off when it already is. Held, the same press talks while held.
 */
export async function voiceTap(press: VoicePress): Promise<void> {
  await desktopApi.voicePress(press);
  await desktopApi.voiceRelease({ heldMs: 0 });
}
