import {
  VOICE_CAPTURE_MESSAGE,
  VOICE_PORT_MESSAGE,
  VOICE_REST_MESSAGE,
  type VoiceAudioDown,
  type VoiceCaptureCommand,
  type VoicePortMessage,
} from "../../shared/voice.js";
import { listen, prepareMicrophone } from "./microphone.js";
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
 * with its microphone closed (ADR 0236). The next voice reuses the graph;
 * opening the physical input still takes the device's own startup time.
 */
/** The voice this page serves now; null while it rests. */
let current: {
  close(): Promise<void>;
  control(command: VoiceCaptureCommand): void;
} | null = null;
/** The shared input graph finishes closing before another voice resumes it. */
let draining = Promise.resolve();
const preparedMicrophone = prepareMicrophone();
window.addEventListener("pagehide", () => {
  void current?.close();
  preparedMicrophone.close();
});

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window) return;
  const data = event.data;
  if (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    data.type === VOICE_CAPTURE_MESSAGE &&
    "command" in data &&
    isCaptureCommand(data.command)
  ) {
    current?.control(data.command);
    return;
  }
  if (isRestMessage(event.data)) {
    draining = current?.close() ?? draining;
    current = null;
    return;
  }
  if (!isPortMessage(event.data)) return;
  const port = event.ports[0];
  if (!port) return;
  draining = current?.close() ?? draining;
  const speaker = new Speaker(port);
  // A reply read aloud only plays: the microphone stays closed.
  const device = event.data.microphone;
  let microphone: ReturnType<typeof listen> | null = null;
  let ended = false;
  let pending = draining;
  let stopping = Promise.resolve();
  const control = (command: VoiceCaptureCommand) => {
    // A following press waits only for the preceding worklet's final frames.
    pending = pending
      .then(async () => {
        if (ended) return;
        if (command.type === "hold" && !command.held) {
          const close = microphone;
          microphone = null;
          await close?.();
          if (ended) return;
        }
        port.postMessage({ type: "control", command });
        if (command.type === "hold" && command.held)
          microphone ??= listen(port, device, preparedMicrophone);
      })
      .catch((cause: unknown) => {
        if (!ended)
          port.postMessage({
            type: "failed",
            message: cause instanceof Error ? cause.message : String(cause),
          });
      });
  };
  if (event.data.listen) control({ type: "hold", held: true });
  const stop = () => {
    ended = true;
    const closed = microphone?.().catch(() => {});
    microphone = null;
    stopping = Promise.all([pending, stopping, closed]).then(() => {});
    return stopping;
  };
  port.onmessage = (message: MessageEvent<VoiceAudioDown>) => {
    if (message.data.type === "close-microphone") {
      draining = stop();
    } else speaker.receive(message.data);
  };
  current = {
    control,
    close: () => {
      port.onmessage = null;
      // The bars hear that what it scheduled will not play.
      speaker.close();
      port.close();
      return stop();
    },
  };
});

function isCaptureCommand(value: unknown): value is VoiceCaptureCommand {
  if (typeof value !== "object" || value === null || !("type" in value))
    return false;
  if (value.type === "forget") return true;
  if (value.type === "dictation")
    return "enabled" in value && typeof value.enabled === "boolean";
  return (
    value.type === "hold" && "held" in value && typeof value.held === "boolean"
  );
}

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
