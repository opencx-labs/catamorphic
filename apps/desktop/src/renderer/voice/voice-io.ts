import {
  VOICE_PORT_MESSAGE,
  VOICE_REST_MESSAGE,
  type VoiceAudioDown,
  type VoicePortMessage,
} from "../../shared/voice.js";
import { listen } from "./microphone.js";
import { Speaker } from "./speaker.js";

/**
 * The audio page (ADR 0216): a hidden window that is the voice agent's
 * microphone and speakers, and nothing else. Its port goes to the speech
 * worker; this page only moves samples. The microphone keeps Chromium's
 * echo cancellation on, which cancels everything Work plays on the output
 * device, the agent's voice included: the agent hearing itself would
 * otherwise read as the person talking over it.
 *
 * Each voice brings its own port. Between voices the page rests, loaded,
 * with its microphone closed (ADR 0236): the next voice only opens the
 * microphone, so the person's first words are heard.
 */
/** The voice this page serves now; null while it rests. */
let current: { close(): void } | null = null;

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window) return;
  if (isRestMessage(event.data)) {
    current?.close();
    current = null;
    return;
  }
  if (!isPortMessage(event.data)) return;
  const port = event.ports[0];
  if (!port) return;
  current?.close();
  const speaker = new Speaker(port);
  // A reply read aloud only plays: the microphone stays closed.
  const microphone = event.data.listen
    ? listen(port, event.data.microphone)
    : () => {};
  port.onmessage = (message: MessageEvent<VoiceAudioDown>) => {
    if (message.data.type === "close-microphone") microphone();
    else speaker.receive(message.data);
  };
  current = {
    close: () => {
      port.onmessage = null;
      // The bars hear that what it scheduled will not play.
      speaker.close();
      port.close();
      microphone();
    },
  };
});

function isRestMessage(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === VOICE_REST_MESSAGE
  );
}

function isPortMessage(value: unknown): value is VoicePortMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === VOICE_PORT_MESSAGE &&
    "microphone" in value &&
    (value.microphone === null || typeof value.microphone === "string") &&
    "listen" in value &&
    typeof value.listen === "boolean"
  );
}
