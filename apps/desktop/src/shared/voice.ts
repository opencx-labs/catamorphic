/**
 * Voice (ADR 0216): speech runs on this machine, and the conversation is
 * an ordinary chat, the assistant's from the dock or any chat from its
 * composer. These types are shared by the main process (which owns the
 * conversation), the speech worker (a utility process running the speech
 * models) and the audio page (a hidden window that owns the microphone and
 * the speakers).
 */

/** What voice is doing, as the microphones show it. */
export type VoicePhase =
  | "off"
  /** Downloading or loading the speech models, opening the microphone. */
  | "preparing"
  | "listening"
  /** The person is talking. */
  | "hearing"
  /** The chat is working on what was said and has nothing to say yet. */
  | "thinking"
  | "speaking";

/** A chat voice talks with. */
export interface VoiceSessionRef {
  projectId: string;
  sessionId: string;
}

/**
 * The voices agents can speak in: Kokoro's own (ADR 0216), the best
 * graded of its American English voices. `speaker` is the voice's index
 * in the model's voice file.
 */
export const VOICES = [
  {
    id: "af_heart",
    name: "Heart",
    description: "American woman",
    speaker: 3,
  },
  {
    id: "af_bella",
    name: "Bella",
    description: "American woman",
    speaker: 2,
  },
  {
    id: "am_michael",
    name: "Michael",
    description: "American man",
    speaker: 16,
  },
  {
    id: "am_fenrir",
    name: "Fenrir",
    description: "American man",
    speaker: 14,
  },
] as const;

export type VoiceId = (typeof VOICES)[number]["id"];

export const DEFAULT_VOICE: VoiceId = "af_heart";

/** A stored voice choice, or the default for anything unknown. */
export function voiceIdOf(value: unknown): VoiceId {
  return VOICES.find((voice) => voice.id === value)?.id ?? DEFAULT_VOICE;
}

/**
 * What voice talks to (ADR 0216): the assistant, from the dock's
 * microphone, or a chat, from its composer's, to that chat's own agent.
 */
export type VoiceTarget =
  | { kind: "assistant" }
  | { kind: "chat"; projectId: string; sessionId: string };

export function sameVoiceTarget(
  a: VoiceTarget | null,
  b: VoiceTarget | null,
): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  return (
    a.kind === "assistant" || (b.kind === "chat" && a.sessionId === b.sessionId)
  );
}

/** An agent's voice: its own, or the profile's default. */
export function agentVoice(
  prefs: { voiceId: VoiceId; agentVoices: Record<string, VoiceId> },
  agentId: string | null,
): VoiceId {
  return (agentId && prefs.agentVoices[agentId]) || prefs.voiceId;
}

/**
 * What voice is doing for a profile. Its settings (the assistant, voices,
 * microphone, push to talk, where microphones show) are the profile's
 * prefs, which a live voice follows.
 */
export interface VoiceStatus {
  phase: VoicePhase;
  /**
   * What voice is talking to while it is on; when it stopped on an error,
   * what it was talking to.
   */
  target: VoiceTarget | null;
  /**
   * The assistant's chat has news the person has not heard: a session it
   * started reported back, or asked something, while voice was off.
   */
  pending: boolean;
  /** Bytes of the speech models still arriving, the first time only. */
  download: { receivedBytes: number; totalBytes: number } | null;
  /** Why voice stopped or could not start. Cleared by the next start. */
  error: string | null;
  /** Voice is learning the person's voice from what they say now. */
  learning: boolean;
}

export const VOICE_OFF: VoiceStatus = {
  phase: "off",
  target: null,
  pending: false,
  download: null,
  error: null,
  learning: false,
};

/** Local files of the speech models, as the worker loads them. */
export interface VoiceModelPaths {
  /** Silero voice activity detector. */
  vad: string;
  /** DPDFNet noise removal, for the voice print. */
  denoiser: string;
  /** WeSpeaker ResNet34 speaker embeddings, for the voice print. */
  speaker: string;
  /** Parakeet TDT transducer. */
  asr: { encoder: string; decoder: string; joiner: string; tokens: string };
  /** Kokoro v1.0 and its voices. */
  tts: {
    model: string;
    voices: string;
    tokens: string;
    lexicon: string;
    dataDir: string;
  };
}

/** Main process → speech worker. */
export type VoiceWorkerCommand =
  /** Carries the audio page's port (the message's only transferred port). */
  | { type: "audio" }
  | {
      type: "start";
      /** `fake` replaces the models for end-to-end tests. */
      speech:
        | { kind: "models"; paths: VoiceModelPaths; voice: VoiceId }
        | FakeSpeechScript;
      /** The person's voice print, when voice knows it. */
      voiceprint: number[] | null;
      pushToTalk: boolean;
    }
  /** Listen only while held (push to talk), or whenever someone speaks. */
  | { type: "push-to-talk"; enabled: boolean }
  /** The push-to-talk keys went down, or came up. */
  | { type: "hold"; held: boolean }
  /** Learn the person's voice from the next few seconds they speak. */
  | { type: "learn" }
  /** Listen to this voice alone from now on; null listens to anyone. */
  | { type: "voiceprint"; voiceprint: number[] | null }
  /** Speak in another voice from the next reply on. */
  | { type: "voice"; voice: VoiceId }
  | { type: "speak"; id: string; text: string }
  /** A short sound that says "heard you", before any words are ready. */
  | { type: "cue" }
  | { type: "stop-speaking" };

export interface FakeSpeechScript {
  kind: "fake";
  /** What the fake recognizer hears once audio starts arriving. */
  utterance: string;
}

/** Speech worker → main process. */
export type VoiceWorkerEvent =
  | { type: "ready" }
  | { type: "failed"; message: string }
  | { type: "speech-start" }
  | { type: "speech-end" }
  /** A transcript the person meant, never an echo of the agent. */
  | { type: "utterance"; text: string }
  /** The person talked over the agent, which stopped speaking. */
  | { type: "barge-in" }
  | { type: "speaking"; id: string }
  | { type: "spoken"; id: string; interrupted: boolean }
  /** The person's voice print, learned from what they just said. */
  | { type: "learned"; voiceprint: number[] }
  /** Someone else spoke: not the voice print's person, so not heard. */
  | { type: "ignored" }
  | ({ type: "levels" } & VoiceLevels);

/**
 * The rate the audio page captures the microphone at, and the detector and
 * recognizer run at: Chromium resamples the device's audio to it properly.
 */
export const SPEECH_SAMPLE_RATE = 16_000;

/** Bars in the speaking animation, one per band of speech, low to high. */
export const VOICE_BARS = 5;

/**
 * How a clip about to play sounds, for the speaking animation: every
 * `frameMs` from `at` (epoch milliseconds, when it is heard), one level
 * from 0 to 1 per bar, `VOICE_BARS` at a time.
 */
export interface VoiceLevels {
  at: number;
  frameMs: number;
  levels: number[];
}

/** Audio page → speech worker, over the transferred port. */
export type VoiceAudioUp =
  | { type: "frame"; samples: Float32Array; sampleRate: number }
  /** Playback reached the end of every chunk up to `seq`. */
  | { type: "drained"; seq: number }
  | ({ type: "levels" } & VoiceLevels)
  | { type: "failed"; message: string };

/** Speech worker → audio page. */
export type VoiceAudioDown =
  | { type: "play"; seq: number; samples: Float32Array; sampleRate: number }
  /** Drop everything queued or playing, now. */
  | { type: "flush"; seq: number };

/** The IPC message that carries the audio port into the audio page. */
export const VOICE_PORT_MESSAGE = "catamorphic:voice-port";

/** What comes with the port: the microphone to open. */
export interface VoicePortMessage {
  type: typeof VOICE_PORT_MESSAGE;
  /** A device id from `enumerateDevices`; null opens the system's. */
  microphone: string | null;
}

/**
 * The assistant (ADR 0216): the agent the dock's microphone talks to, in
 * the profile's assistant chat. One of the person's own agents with the
 * assistant's tools over their chats: Work's built-in assistant on their
 * default agent's harness and login, with no instructions of its own and
 * the harness's default model (`work-assistant:<agent id>`), or an agent
 * they chose, as they configured it (`assistant:<agent id>`).
 */
const ASSISTANT_PREFIX = "assistant:";
const BUILT_IN_ASSISTANT_PREFIX = "work-assistant:";

export interface AssistantAgent {
  /** The person's agent it runs on. */
  agentId: string;
  /** Work's built-in assistant, not the agent as configured. */
  builtIn: boolean;
}

export function assistantAgentId({ agentId, builtIn }: AssistantAgent): string {
  return `${builtIn ? BUILT_IN_ASSISTANT_PREFIX : ASSISTANT_PREFIX}${agentId}`;
}

/** The assistant an agent id names, or null for any other agent. */
export function parseAssistantAgentId(id: string): AssistantAgent | null {
  for (const [prefix, builtIn] of [
    [BUILT_IN_ASSISTANT_PREFIX, true],
    [ASSISTANT_PREFIX, false],
  ] as const)
    if (id.startsWith(prefix) && id.length > prefix.length)
      return { agentId: id.slice(prefix.length), builtIn };
  return null;
}

/** The roster agent behind an id: an assistant's agent, else the id. */
export function rosterAgentId(id: string): string {
  return parseAssistantAgentId(id)?.agentId ?? id;
}
