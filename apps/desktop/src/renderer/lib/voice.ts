import type { VoicePress } from "../../shared/voice.js";
import { desktopApi } from "./desktop-api.js";

/**
 * A palette action sends a zero-length push-to-talk press. Physical
 * microphones and shortcuts capture only while held.
 */
export async function voiceTap(press: VoicePress): Promise<void> {
  await desktopApi.voicePress(press);
  await desktopApi.voiceRelease();
}
