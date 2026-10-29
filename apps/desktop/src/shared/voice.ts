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
 * What voice does (ADR 0216, 0236): talk with the assistant, or with a
 * chat's own agent, or dictate into the text field the person is in.
 * Dictation started from a chat's microphone names that chat, so its
 * microphone shows it.
 */
export type VoiceTarget =
  | { kind: "assistant" }
  | { kind: "chat"; projectId: string; sessionId: string }
  | { kind: "dictation"; sessionId?: string };

/**
 * What a microphone or a shortcut asks of voice (ADR 0236): a tap turns
 * it on or off, a hold talks while held.
 */
export type VoiceAction = "dictate" | "talk-to-work" | "talk-to-chat";

/** Voice's shortcuts: the main process reads them, never a page. */
export const VOICE_ACTIONS: readonly VoiceAction[] = [
  "dictate",
  "talk-to-work",
  "talk-to-chat",
];

export function isVoiceAction(action: string): action is VoiceAction {
  return VOICE_ACTIONS.some((voiceAction) => voiceAction === action);
}

/** A press of a microphone, or of a voice shortcut from a page. */
export interface VoicePress {
  action: VoiceAction;
  projectId?: string;
  /** The chat a chat's microphone belongs to. */
  sessionId?: string;
}

/**
 * Whether a press asks for what voice is doing now. Dictation pressed
 * from anywhere (its shortcut, the dock) is whatever dictation is on;
 * from a chat's composer, dictation into that chat.
 */
export function sameVoiceTarget(
  now: VoiceTarget | null,
  asked: VoiceTarget | null,
): boolean {
  if (!now || !asked) return false;
  if (now.kind === "assistant") return asked.kind === "assistant";
  if (now.kind === "dictation")
    return (
      asked.kind === "dictation" &&
      (!asked.sessionId || asked.sessionId === now.sessionId)
    );
  return asked.kind === "chat" && asked.sessionId === now.sessionId;
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
 * microphone, dictation only, where microphones show) are the profile's
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
  /** Voice writes what the person says where they type: dictation. */
  dictation: boolean;
  /**
   * Voice listens on its own (it was tapped on); else only while held (it
   * was started by holding a shortcut or a microphone).
   */
  handsFree: boolean;
  /**
   * The reply being read aloud from its button (ADR 0268), voice on or
   * off: `preparing` until its first words play.
   */
  reading: VoiceReading | null;
}

/** A reply read aloud: the message, and whether it is still on its way. */
export interface VoiceReading {
  itemId: string;
  preparing: boolean;
}

/** What a reply's read aloud button asks for. */
export interface VoiceReadAloud {
  itemId: string;
  /** The reply as the agent wrote it (Markdown); voice reads its words. */
  text: string;
  /** Whose reply: it is read in that agent's voice. */
  agentId: string | null;
}

export const VOICE_OFF: VoiceStatus = {
  phase: "off",
  target: null,
  pending: false,
  download: null,
  error: null,
  learning: false,
  dictation: false,
  handsFree: false,
  reading: null,
};

/**
 * Dictation's words for one stretch of speech, on their way to the text
 * field the person is in (ADR 0236).
 */
export interface VoiceDictation {
  /** One stretch of speech; a later stretch has a larger number. */
  segment: number;
  text: string;
  /** The stretch is over: `text` is what was said, empty for nothing. */
  final: boolean;
}

/**
 * Where voice's shortcuts work (ADR 0236): in Work's windows, or in every
 * app (macOS, once Work is allowed in Accessibility).
 */
export type VoiceKeysState =
  | "app"
  | "everywhere"
  | "needs-permission"
  | "unsupported";

/**
 * The person's voice, as the speaker model hears it (ADR 0236). A print
 * names its model: one made by another cannot be compared, and is
 * forgotten.
 */
export interface Voiceprint {
  model: typeof VOICEPRINT_MODEL;
  vector: number[];
}

export const VOICEPRINT_MODEL = "eres2net-voxceleb";

/** A stored voice print the speaker model can use, else null. */
export function voiceprintOf(value: unknown): Voiceprint | null {
  if (typeof value !== "object" || value === null) return null;
  const model = "model" in value ? value.model : undefined;
  const vector = "vector" in value ? value.vector : undefined;
  return model === VOICEPRINT_MODEL &&
    Array.isArray(vector) &&
    vector.length > 0 &&
    vector.every((entry) => typeof entry === "number")
    ? { model, vector }
    : null;
}

/** Local files of the speech models, as the worker loads them. */
export interface VoiceModelPaths {
  /** Silero voice activity detector. */
  vad: string;
  /** ERes2Net speaker embeddings: who is speaking. */
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
      handsFree: boolean;
      dictation: boolean;
    }
  /** Listen whenever someone speaks, or only while held. */
  | { type: "hands-free"; enabled: boolean }
  /**
   * Voice is off: drop the conversation and close the microphone, keep the
   * models loaded for the next start.
   */
  | { type: "rest" }
  /** Write what the person says into a composer, or talk with the agent. */
  | { type: "dictation"; enabled: boolean }
  /**
   * The keys or a microphone went down, or came up; `discard` drops what a
   * tap caught.
   */
  | { type: "hold"; held: boolean; discard?: boolean; release?: number }
  /** Hear nothing more; speech already asked for is still said. */
  | { type: "stop-listening" }
  /**
   * Voice is ending: dictation hears what the person is still saying, then
   * nothing more; `finished` says when all of it is written.
   */
  | { type: "finish" }
  /** Voice moved on: drop what was said for where it was before. */
  | { type: "forget" }
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
  /** The person started talking: the `segment`th stretch of speech. */
  | { type: "speech-start"; segment: number }
  | { type: "speech-end" }
  /**
   * A transcript the person meant, never an echo of the agent, and the
   * stretch it was said in.
   */
  | { type: "utterance"; text: string; segment: number }
  /**
   * Dictation's words for one stretch of speech: while it goes on, what
   * was said so far; once it ends (`final`), what was said, empty when
   * nothing was or it was someone else.
   */
  | { type: "dictation"; segment: number; text: string; final: boolean }
  /** The person talked over the agent, which stopped speaking. */
  | { type: "barge-in" }
  | { type: "speaking"; id: string }
  | { type: "spoken"; id: string; interrupted: boolean }
  /** The person's voice print, learned from what they just said. */
  | { type: "learned"; voiceprint: number[] }
  /** Someone else spoke: not the voice print's person, so not heard. */
  | { type: "ignored" }
  /** The keys or the microphone were held, and let go with no words said. */
  | { type: "unheard"; release?: number }
  /** All pieces, including the tail, of this released hold have been recognized. */
  | { type: "hold-recognized"; release: number }
  /** Everything heard before `finish` is recognized and said. */
  | { type: "finished" }
  | ({ type: "levels" } & VoiceLevels)
  /** The microphone voice listens with, by its label (ADR 0268). */
  | { type: "microphone"; label: string };

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
  /**
   * The clips shown before this one are not heard as scheduled: playback
   * paused, stopped or carried on later (ADR 0265). Their bars go.
   */
  reset?: boolean;
}

/** Audio page → speech worker, over the transferred port. */
export type VoiceAudioUp =
  | { type: "frame"; samples: Float32Array; sampleRate: number }
  /** Playback reached the end of every chunk up to `seq`. */
  | { type: "drained"; seq: number }
  | ({ type: "levels" } & VoiceLevels)
  | { type: "failed"; message: string }
  /** The microphone the page opened, by its label, as it opens. */
  | { type: "microphone"; label: string };

/** Speech worker → audio page. */
export type VoiceAudioDown =
  | { type: "play"; seq: number; samples: Float32Array; sampleRate: number }
  /** Drop everything queued or playing, now. */
  | { type: "flush"; seq: number }
  /**
   * The person is talking over the agent (ADR 0265): hold everything
   * queued or playing where it is, and what comes after it, until resumed
   * or flushed.
   */
  | { type: "pause" }
  /** Carry on from where playback paused. */
  | { type: "resume" }
  /** Stop capturing for good: the microphone goes off, playback goes on. */
  | { type: "close-microphone" };

/** Update physical capture without replacing the playback port. */
export const VOICE_CAPTURE_MESSAGE = "catamorphic:voice-capture";

/** The IPC message that carries the audio port into the audio page. */
export const VOICE_PORT_MESSAGE = "catamorphic:voice-port";

/** What comes with the port: the microphone to open. */
export interface VoicePortMessage {
  type: typeof VOICE_PORT_MESSAGE;
  /** A device id from `enumerateDevices`; null opens the system's. */
  microphone: string | null;
  /** Open the microphone; false only plays (a reply read aloud). */
  listen: boolean;
}

/**
 * What voice's bubble shows (ADR 0236): whether it is up, the profile its
 * page reads, and the project whose colours it wears.
 */
export interface VoiceBubbleState {
  shown: boolean;
  profileId: string | null;
  projectId: string | null;
}

/** A window of Work's whose assistant the bubble can talk to. */
export interface VoiceWindowChoice {
  id: number;
  /** The window's title: its project's name. */
  title: string;
  /** Its assistant's name; null when it has none yet. */
  assistant: string | null;
  /** Its profile's name, when windows of several profiles are open. */
  profile?: string;
  /** The window voice talks to the assistant of now. */
  current: boolean;
}

/**
 * The IPC message that rests the audio page between voices (ADR 0236):
 * its microphone closes and its speakers stop, and it stays loaded, so
 * the next voice opens the microphone at once.
 */
export const VOICE_REST_MESSAGE = "catamorphic:voice-rest";

export interface VoiceRestMessage {
  type: typeof VOICE_REST_MESSAGE;
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
