import { randomUUID } from "node:crypto";
import path from "node:path";
import { parseProjectAgentId, steeredTurnId } from "@catamorphic/core";
import {
  app,
  BrowserWindow,
  ipcMain,
  MessageChannelMain,
  shell,
  systemPreferences,
  type UtilityProcess,
  utilityProcess,
  type WebContents,
  type WebFrameMain,
} from "electron";
import { z } from "zod";
import type { AppPrefs } from "../../shared/app-prefs.js";
import type { MenuItem } from "../../shared/menu.js";
import {
  type AssistantAgent,
  agentVoice,
  assistantAgentId,
  parseAssistantAgentId,
  sameVoiceTarget,
  VOICE_ACTIONS,
  VOICE_OFF,
  VOICE_PORT_MESSAGE,
  VOICE_REST_MESSAGE,
  VOICEPRINT_MODEL,
  type VoiceAction,
  type VoiceDictation,
  type VoiceId,
  type VoiceKeysState,
  type VoicePress,
  type VoiceReadAloud,
  type VoiceSessionRef,
  type VoiceStatus,
  type VoiceTarget,
  type VoiceWindowChoice,
  type VoiceWorkerCommand,
  type VoiceWorkerEvent,
} from "../../shared/voice.js";
import type { IncognitoSessionsStore } from "../incognito-sessions.js";
import type { WindowProfileRegistry } from "../index.js";
import type { ServerState } from "../ipc.js";
import { popupNativeMenu } from "../native-menu.js";
import type { ProfileConfigManager } from "../profile-config.js";
import type { ProfilesStore } from "../profiles.js";
import { DESKTOP_TENANT_ID, DESKTOP_USER_ID } from "../server/boot.js";
import {
  unheardReplies,
  VoiceConversation,
  voiceChatOf,
} from "./conversation.js";
import { VoiceModelStore } from "./models.js";
import {
  type Sight,
  type SpokenSight,
  SpokenSights,
  sightFor,
  takePicture,
} from "./sight.js";
import { isStopCommand, speakableText } from "./speech-text.js";
import { SystemKeys } from "./system-keys.js";
import { createVoiceBubble, voiceBubbleDragSchema } from "./voice-bubble.js";
import { listenForVoiceKeys } from "./voice-keys.js";
import { QUIET_PHASES, VoiceQuiet } from "./voice-quiet.js";

/** What voice says when it starts learning the person's voice. */
const LEARN_PROMPT =
  "Let me learn your voice. Talk to me for a few seconds, about anything, the way you normally would.";
const LEARNED_REPLY =
  "Got it. I know your voice now, and I'll only listen to you.";

/** How often the assistant's chat is checked for news while voice is off. */
const NEWS_POLL_MS = 5_000;
/** A press shorter than this is a tap: voice on, or off (ADR 0236). */
const TAP_MS = 300;
/** A voice started by holding turns off once it has been idle this long. */
const HELD_IDLE_MS = 4_000;

/** The speech models stay loaded this long after voice stops. */
const WARM_MS = 15 * 60_000;
/** Dictation turned off writes what it still hears for at most this long. */
const FINISH_MS = 4_000;
/** Speech starting again this soon was seen as the stretch before it. */
const SIGHT_REUSE_MS = 1_000;
/** Sights of stretches whose words are not heard yet, at most. */
const SIGHTS_KEPT = 4;

const identity = {
  tenantId: DESKTOP_TENANT_ID,
  externalUserId: DESKTOP_USER_ID,
};

/**
 * What voice was asked to do: talk with the assistant, from a project, or
 * with a chat; or dictate, from a chat's microphone (`sessionId`) or
 * anywhere.
 */
type VoiceRequest =
  | { kind: "assistant"; projectId: string }
  | { kind: "chat"; projectId: string; sessionId: string }
  | { kind: "dictation"; sessionId?: string };

function targetOf(request: VoiceRequest): VoiceTarget {
  if (request.kind === "assistant") return { kind: "assistant" };
  if (request.kind === "dictation")
    return request.sessionId
      ? { kind: "dictation", sessionId: request.sessionId }
      : { kind: "dictation" };
  return {
    kind: "chat",
    projectId: request.projectId,
    sessionId: request.sessionId,
  };
}

/** What a live voice is doing. */
type LiveStatus = Pick<
  VoiceStatus,
  "phase" | "target" | "download" | "learning" | "dictation" | "handsFree"
>;

/** The stored choices a live voice runs with. */
interface Applied {
  voice: VoiceId;
  microphone: string | null;
  voiceprint: number[] | null;
  assistant: string | null;
}

function appliedOf(stored: AppPrefs, voiceOf: string | null): Applied {
  return {
    voice: agentVoice(stored, voiceOf),
    microphone: stored.voiceMicrophone,
    voiceprint: stored.voiceprint?.vector ?? null,
    assistant: stored.voiceAssistant,
  };
}

/**
 * Dictation (ADR 0236): what the person says goes into the text field
 * they are in, a stretch of speech at a time.
 */
interface Dictation {
  /**
   * Where each stretch of the speech worker's goes, settled when its words
   * first come, and its number for the field: unique for Work's life, as a
   * page outlives voice and remembers the stretches it has written.
   */
  stretches: Map<
    number,
    { sink: DictationSink; stretch: number; text: string }
  >;
  /** Stretches written into another app so far, to space the next one. */
  typedInApp: number;
}

/**
 * Where one stretch of dictation goes: a page of Work's, or the app in
 * front, spaced from the stretch before.
 */
type DictationSink =
  | { kind: "field"; frame: WebFrameMain }
  | { kind: "app"; spaced: boolean }
  /** The person moved on mid-stretch: the rest of it is not written. */
  | { kind: "settled" };

interface ActiveVoice {
  profileId: string;
  worker: UtilityProcess;
  /** This voice's listeners on the worker, taken off when it rests. */
  detach: () => void;
  audioWindow: BrowserWindow | null;
  /** Talking with a chat: its conversation. Null while dictating. */
  conversation: VoiceConversation | null;
  /** Dictating into text fields instead of talking with a chat. */
  dictating: Dictation | null;
  /** Whose voice it speaks in: an agent's, or null for the default voice. */
  voiceOf: string | null;
  hearing: boolean;
  speaking: Set<string>;
  busy: boolean;
  /**
   * The chat's agent stopped listening: voice turns off once its turn is
   * over and said.
   */
  ending: boolean;
  /** Listening on its own; else only while held, and off once idle. */
  handsFree: boolean;
  /**
   * Heard before voice reached its chat and the chat caught the person up
   * (its news said first): handed over then.
   */
  early: VoiceWorkerEvent[];
  /** The conversation reading what the person has not heard, if any. */
  catchingUp: VoiceConversation | null;
  /**
   * What the person saw as each stretch of their speech began (ADR 0265),
   * by the stretch's number, until its words are heard.
   */
  sights: Map<number, Sight>;
  /**
   * The window of Work's whose assistant and colours the bubble shows:
   * the last one the person was in, or the one they picked in its menu.
   */
  window: number | null;
  windowPicked: boolean;
  idle: ReturnType<typeof setTimeout> | undefined;
  /** Dictation turned off, writing what it still heard: then it stops. */
  finishing: ReturnType<typeof setTimeout> | undefined;
  live: LiveStatus;
  applied: Applied;
  /** Microphone moves, one at a time: each opens the audio page anew. */
  moving: Promise<void>;
  /** The label of the microphone the audio page opened; null until then. */
  microphone: string | null;
}

/** A reply read aloud from its button (ADR 0268). */
interface Reading {
  profileId: string;
  itemId: string;
  /** The utterance the speech worker reports on: one per press. */
  id: string;
  preparing: boolean;
  /** Voice was off: the worker and audio page it borrowed until said. */
  borrowed: {
    worker: UtilityProcess;
    audio: BrowserWindow | null;
    detach: () => void;
  } | null;
}

const readAloudSchema = z.object({
  itemId: z.string().min(1).max(200),
  text: z.string().max(200_000),
  agentId: z.string().min(1).nullable(),
});

/** A microphone or shortcut held down, until it comes up. */
interface Press {
  profileId: string;
  at: number;
  /** It pressed what voice was already doing: a tap turns it off. */
  wasOn: boolean;
  /** It was a shortcut pressed in Work: the first may ask for every app. */
  key: boolean;
  /** The helper read it, in any app: its release comes from the helper. */
  helper: boolean;
}

/**
 * Voice's main-process side (ADR 0216, 0236). One voice is live at a time,
 * for one profile: it owns the speech worker and the hidden audio window
 * (the microphone and speakers), and either talks with one chat, the
 * assistant's or any chat's, or dictates into the text field the person
 * is in. Microphones and shortcuts press it: a tap turns it on or off, a
 * hold talks while held. Its settings are the profile's prefs, wherever
 * they change: a live voice follows them. The assistant's chat is kept
 * there too, until a reset or another assistant replaces it.
 */
export function registerVoiceSupport(deps: {
  state: ServerState;
  profileConfig: ProfileConfigManager;
  profiles: ProfilesStore;
  windows: WindowProfileRegistry;
  /** Chats kept on this computer (ADR 0062), the assistant's among them. */
  incognito: IncognitoSessionsStore;
  /** Whether a profile's dock floats detached now, as the person left it. */
  dockDetached: (profileId: string) => boolean;
  /** Whether a window is a workspace: not the dock, nor a popup. */
  isWorkspace: (window: BrowserWindow) => boolean;
  /** The project a workspace window shows now, if it shows one. */
  activeProject: (window: BrowserWindow) => string | null;
}): { dispose: () => Promise<void> } {
  const { state, profileConfig, profiles, windows, incognito } = deps;
  const models = new VoiceModelStore({
    rootDir:
      process.env.CATAMORPHIC_VOICE_MODELS_DIR ??
      path.join(app.getPath("userData"), "voice-models"),
  });
  // E2E: scripted speech instead of models and a microphone (a JSON list
  // of what the person "says", one utterance per start, in turn).
  const fakeUtterances = parseFakeUtterances(
    process.env.CATAMORPHIC_E2E_FAKE_VOICE,
  );
  let fakeStarts = 0;
  let active: ActiveVoice | null = null;
  /**
   * The reply read aloud from its button, voice on or off (ADR 0268). Off,
   * it borrows the speech worker and audio page, the microphone closed.
   */
  let reading: Reading | null = null;
  /**
   * Other apps' audio, lowered while voice listens, hears the person or
   * waits on the agent (ADR 0268): on macOS, through the helper, never
   * with scripted speech. It comes back up while the agent speaks, which
   * macOS would lower too, and when voice turns off the helper goes.
   */
  const quiet =
    process.platform === "darwin" && !fakeUtterances
      ? new VoiceQuiet({
          helperPath: app.isPackaged
            ? path.join(process.resourcesPath, "..", "MacOS", "voice-quiet")
            : path.join(
                app.getAppPath(),
                "native",
                "voice-quiet",
                "bin",
                "voice-quiet",
              ),
        })
      : null;
  const settleQuiet = () => {
    const voice = active;
    if (!voice) {
      quiet?.stop();
      return;
    }
    quiet?.set({
      quiet: !voice.ending && QUIET_PHASES.has(voice.live.phase),
      microphone: voice.microphone,
    });
  };
  let disposed = false;
  /** Why each profile's voice stopped, and what it was talking to. */
  const errors = new Map<
    string,
    { message: string; target: VoiceTarget | null }
  >();
  /** Profiles whose assistant has replies the person has not heard. */
  const news = new Set<string>();
  /** What each profile talked to last: where a new assistant moves it. */
  const lastRequests = new Map<string, VoiceRequest>();
  /** The press under way, if any. */
  let press: Press | null = null;
  /** Dictation's stretches so far, every voice's: the last one's number. */
  let stretches = 0;
  const bubble = createVoiceBubble({
    attach: (contents, profileId) => windows.attach(contents, profileId),
    spotOf: (profileId) => prefs(profileId).load().voiceBubbleSpot,
    saveSpot: (profileId, spot) =>
      prefs(profileId).save({ voiceBubbleSpot: spot }),
  });
  /** Voice moving to another window's assistant: the bubble stays up. */
  let switching = false;
  // The bubble is too small for a menu inside it: its menus are native.
  ipcMain.handle(
    "catamorphic:voice-bubble-menu",
    (event, entries: readonly MenuItem[]) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      return window && bubble.pageOf(event.sender) === "bubble"
        ? popupNativeMenu(window, entries)
        : null;
    },
  );

  const prefs = (profileId: string) =>
    profileConfig.forProfile(profileId).prefs;

  /** Work's windows the person was in, the latest first. */
  let recentWindows: BrowserWindow[] = [];
  /** A workspace window, open, of this profile. */
  const ofProfile = (window: BrowserWindow, profileId: string) =>
    !window.isDestroyed() &&
    deps.isWorkspace(window) &&
    windows.profileFor(window.webContents) === profileId;
  /** The last workspace window of a profile the person was in. */
  const windowFor = (profileId: string): BrowserWindow | null =>
    recentWindows.find((window) => ofProfile(window, profileId)) ?? null;
  /** The window a voice talks for, while it is still that profile's. */
  const voiceWindow = (voice: ActiveVoice): BrowserWindow | null => {
    const window =
      voice.window === null ? null : BrowserWindow.fromId(voice.window);
    return window && ofProfile(window, voice.profileId) ? window : null;
  };
  /** The project a window shows, else its profile's last one. */
  const windowProject = (
    window: BrowserWindow | null,
    profileId: string,
  ): string | null =>
    (window ? deps.activeProject(window) : null) ??
    prefs(profileId).load().lastProjectId ??
    null;
  /** Work's windows the person works in: not the audio page or bubble. */
  const workWindows = () =>
    BrowserWindow.getAllWindows().filter(
      (window) =>
        !window.isDestroyed() && !isAudioWindow(window) && !bubble.owns(window),
    );
  /** Whether one of Work's own windows is in front. */
  const workInFront = () => {
    const focused = BrowserWindow.getFocusedWindow();
    return !!focused && workWindows().includes(focused);
  };

  const statusFor = (profileId: string): VoiceStatus => {
    const pending = news.has(profileId);
    const read =
      reading?.profileId === profileId
        ? { itemId: reading.itemId, preparing: reading.preparing }
        : null;
    if (active?.profileId === profileId)
      return { ...VOICE_OFF, ...active.live, pending, reading: read };
    const error = errors.get(profileId);
    return {
      ...VOICE_OFF,
      pending,
      reading: read,
      ...(error ? { error: error.message, target: error.target } : {}),
    };
  };

  /**
   * Out of Work, the dock's microphone floats where the person can see
   * and stop voice, unless their dock is detached and floats there already.
   */
  const refreshBubble = () => {
    // Moving to another window's assistant: up until the next voice says.
    if (switching) return;
    const voice = active;
    if (
      !voice ||
      disposed ||
      workInFront() ||
      deps.dockDetached(voice.profileId)
    ) {
      bubble.show(null);
      return;
    }
    // Coming up, it wears the last window the person was in, unless they
    // picked one in its menu that is still there.
    if ((!bubble.state().shown && !voice.windowPicked) || !voiceWindow(voice))
      voice.window = windowFor(voice.profileId)?.id ?? null;
    bubble.show({
      profileId: voice.profileId,
      projectId: windowProject(voiceWindow(voice), voice.profileId),
    });
  };

  const publish = () => {
    settleQuiet();
    // The bubble first: it may read another profile's status from now.
    refreshBubble();
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || isAudioWindow(window)) continue;
      // Moving to another window's assistant, the bubble shows no "off".
      if (switching && bubble.owns(window)) continue;
      window.webContents.send(
        "catamorphic:voice-status",
        statusFor(windows.profileFor(window.webContents)),
      );
    }
  };

  /** A voice started by holding goes off when nothing is left to do. */
  const settleIdle = (voice: ActiveVoice) => {
    clearTimeout(voice.idle);
    if (
      voice.handsFree ||
      voice.ending ||
      press?.profileId === voice.profileId ||
      voice.live.phase !== "listening"
    )
      return;
    voice.idle = setTimeout(() => {
      if (active === voice && !press && voice.live.phase === "listening")
        void stop();
    }, HELD_IDLE_MS);
  };

  const update = (voice: ActiveVoice, patch: Partial<LiveStatus> = {}) => {
    if (active !== voice) return;
    const phase =
      voice.live.phase === "preparing" && !connected(voice)
        ? "preparing"
        : voice.hearing
          ? "hearing"
          : voice.speaking.size > 0
            ? "speaking"
            : voice.busy || voice.ending
              ? "thinking"
              : "listening";
    voice.live = {
      ...voice.live,
      phase,
      handsFree: voice.handsFree,
      ...patch,
    };
    settleIdle(voice);
    publish();
  };

  /** Voice talks with its chat, or dictates: it is ready. */
  const connected = (voice: ActiveVoice) =>
    voice.conversation !== null || voice.dictating !== null;

  const send = (voice: ActiveVoice, command: VoiceWorkerCommand) => {
    if (active === voice) voice.worker.postMessage(command);
  };

  /**
   * The speech worker and the audio page between voices: the models stay
   * loaded and the page stays open, its microphone closed, a while, so
   * the next start hears at once (ADR 0236). Then they go.
   */
  let resting: {
    worker: UtilityProcess;
    audio: BrowserWindow | null;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  /** An audio page whose renderer went: it can hear nothing more. */
  const audioGone = (window: BrowserWindow) => {
    if (resting?.audio === window) resting.audio = null;
    if (reading?.borrowed?.audio === window) endReading();
    if (active?.audioWindow === window)
      void stop("The microphone stopped. Turn voice on again.");
  };
  /** Workers that stopped: one not yet started is not among them. */
  const exited = new WeakSet<UtilityProcess>();
  const letGo = (warm: NonNullable<typeof resting>) => {
    clearTimeout(warm.timer);
    warm.worker.kill();
    if (warm.audio && !warm.audio.isDestroyed()) warm.audio.destroy();
  };
  const takeWarm = (): {
    worker: UtilityProcess;
    audio: BrowserWindow | null;
  } => {
    const warm = resting;
    resting = null;
    if (warm) {
      clearTimeout(warm.timer);
      const audio = warm.audio?.isDestroyed() ? null : warm.audio;
      return { worker: warm.worker, audio };
    }
    const worker = utilityProcess.fork(
      path.join(import.meta.dirname, "voice-worker.js"),
      [],
      { serviceName: "Work Voice" },
    );
    worker.once("exit", () => {
      exited.add(worker);
      if (resting?.worker !== worker) return;
      const warm = resting;
      resting = null;
      letGo(warm);
    });
    return { worker, audio: null };
  };
  const rest = (worker: UtilityProcess, audio: BrowserWindow | null) => {
    const live = audio && !audio.isDestroyed() ? audio : null;
    // A worker that stopped has nothing to keep warm.
    if (disposed || exited.has(worker)) {
      worker.kill();
      live?.destroy();
      return;
    }
    worker.postMessage({ type: "rest" } satisfies VoiceWorkerCommand);
    live?.webContents.send(VOICE_REST_MESSAGE);
    const timer = setTimeout(() => {
      if (resting?.worker !== worker) return;
      const warm = resting;
      resting = null;
      letGo(warm);
    }, WARM_MS);
    timer.unref?.();
    resting = { worker, audio: live, timer };
  };

  const stop = async (error?: string) => {
    const voice = active;
    if (!voice) return;
    active = null;
    // A reply it was reading goes with it.
    if (reading && !reading.borrowed) reading = null;
    clearTimeout(voice.idle);
    clearTimeout(voice.finishing);
    settleDictation(voice);
    watchSend();
    voice.conversation?.stop();
    voice.detach();
    rest(voice.worker, voice.audioWindow);
    if (error)
      errors.set(voice.profileId, {
        message: error,
        target: voice.live.target,
      });
    publish();
  };

  /** The reply stops being read: what it borrowed rests, warm for voice. */
  const endReading = () => {
    const was = reading;
    if (!was) return;
    reading = null;
    if (was.borrowed) {
      was.borrowed.detach();
      rest(was.borrowed.worker, was.borrowed.audio);
    }
    publish();
  };

  /**
   * Read a reply aloud in its agent's voice (ADR 0268); pressed again, or
   * for another reply, the one being read stops. With voice on, voice says
   * it as it says a reply, and talking over it stops it the same way. Off,
   * the speech worker and audio page say it with the microphone closed,
   * and rest once it is said.
   */
  const readAloud = async (profileId: string, input: VoiceReadAloud) => {
    const again =
      reading?.profileId === profileId && reading.itemId === input.itemId;
    if (reading) {
      if (!reading.borrowed && active) send(active, { type: "stop-speaking" });
      endReading();
    }
    if (again) return;
    const text = speakableText(input.text);
    if (!text.trim()) return;
    const id = `read-${randomUUID()}`;
    if (active) {
      reading = {
        profileId,
        itemId: input.itemId,
        id,
        preparing: true,
        borrowed: null,
      };
      send(active, { type: "speak", id, text });
      publish();
      return;
    }
    const warm = takeWarm();
    const borrowed: NonNullable<Reading["borrowed"]> = {
      worker: warm.worker,
      audio: warm.audio,
      detach: () => {},
    };
    const mine: Reading = {
      profileId,
      itemId: input.itemId,
      id,
      preparing: true,
      borrowed,
    };
    reading = mine;
    publish();
    const onMessage = (event: VoiceWorkerEvent) => {
      if (reading !== mine) return;
      if (event.type === "speaking" && event.id === id) {
        mine.preparing = false;
        publish();
      } else if (
        (event.type === "spoken" && event.id === id) ||
        event.type === "failed"
      )
        endReading();
    };
    const onExit = () => {
      if (reading === mine) endReading();
    };
    warm.worker.on("message", onMessage);
    warm.worker.once("exit", onExit);
    borrowed.detach = () => {
      warm.worker.off("message", onMessage);
      warm.worker.off("exit", onExit);
    };
    try {
      const paths = fakeUtterances ? null : await models.ensure(() => {});
      if (reading !== mine) return;
      const window = warm.audio ?? (await openAudioWindow(audioGone));
      if (reading !== mine) {
        if (window !== warm.audio) window.destroy();
        return;
      }
      borrowed.audio = window;
      // The page and its port first: the speech plays as soon as it is made.
      connectAudio(window, warm.worker, { microphone: null, listen: false });
      warm.worker.postMessage({
        type: "start",
        speech: paths
          ? {
              kind: "models",
              paths,
              voice: agentVoice(prefs(profileId).load(), input.agentId),
            }
          : { kind: "fake", utterance: "" },
        voiceprint: null,
        handsFree: false,
        dictation: false,
      } satisfies VoiceWorkerCommand);
      warm.worker.postMessage({
        type: "speak",
        id,
        text,
      } satisfies VoiceWorkerCommand);
    } catch (cause) {
      if (reading === mine) endReading();
      console.warn("[voice] reading a reply aloud failed:", cause);
    }
  };

  const agentSessions = () => {
    const service = state.current?.catamorphic.core.agentSessions;
    if (!service) throw new Error("Work is still starting.");
    return service;
  };

  /** Whether the person is talking with this chat by voice now. */
  const talking = (sessionId: string) =>
    !active?.ending && active?.conversation?.ref.sessionId === sessionId;

  /**
   * What the person saw as they started saying their latest message to
   * each chat (ADR 0265), whether or not voice is still on.
   */
  const spoken = new SpokenSights();
  const sight = (sessionId: string) => spoken.get(sessionId);

  /**
   * A chat's agent stops listening (its stop_listening tool): the person
   * is no longer heard, and voice turns off once the turn is said.
   */
  const stopListening = (sessionId: string): boolean => {
    const voice = active;
    const conversation = voice?.conversation;
    if (!voice || conversation?.ref.sessionId !== sessionId) return false;
    // Asked again before it is over: it is ending already.
    if (voice.ending) return true;
    voice.ending = true;
    voice.hearing = false;
    send(voice, { type: "stop-listening" });
    update(voice, { learning: false });
    conversation.finish(() => {
      if (active === voice) void stop();
    });
    return true;
  };

  /**
   * The assistant: the person's chosen agent while it exists, else Work's
   * built-in assistant on their default agent: the project's default when
   * it is one of their own agents, else the profile's (a committed project
   * agent carries its own persona and tools).
   */
  const assistantFor = (
    profileId: string,
    projectId: string,
  ): AssistantAgent | null => {
    const chosen = prefs(profileId).load().voiceAssistant;
    if (chosen && profileConfig.forProfile(profileId).agents.get(chosen))
      return { agentId: chosen, builtIn: false };
    const projectDefault =
      state.current?.agentRegistry.defaultAgentId(projectId);
    const base =
      projectDefault && !parseProjectAgentId(projectDefault)
        ? projectDefault
        : profileConfig.forProfile(profileId).agents.defaultAgentId();
    return base ? { agentId: base, builtIn: true } : null;
  };

  /** Whether a project's chats live on a Work server (ADR 0055). */
  const linked = (profileId: string, projectId: string) =>
    profileConfig.forProfile(profileId).remoteProjects.inspect(projectId) !==
    null;

  /**
   * Where the assistant's chat lives: a project of the profile on this
   * computer, the dock's when it is one. It reads every project, so it
   * never lives where chats go to a server.
   */
  const assistantHome = (profileId: string, projectId: string): string => {
    const profile = profiles.get(profileId);
    const home = [
      projectId,
      profile?.defaultProjectId,
      ...(profile?.projectIds ?? []),
    ].find(
      (id): id is string =>
        !!id &&
        (profile?.projectIds.includes(id) ?? false) &&
        !linked(profileId, id),
    );
    if (!home)
      throw new Error(
        "The assistant needs a project on this computer. Create one to talk to Work.",
      );
    return home;
  };

  /**
   * The assistant's chat: the stored one while it runs on the assistant
   * the person has now, else a new one. The built-in assistant runs at
   * its harness's default model; a chosen agent at its own.
   */
  const assistantChat = async (
    profileId: string,
    projectId: string,
  ): Promise<VoiceSessionRef> => {
    const home = assistantHome(profileId, projectId);
    const assistant = assistantFor(profileId, home);
    if (!assistant)
      throw new Error("Add an agent in Settings to talk to Work.");
    const agentId = assistantAgentId(assistant);
    const stored = prefs(profileId).load().assistantSession;
    if (stored && !linked(profileId, stored.projectId)) {
      const existing = await agentSessions()
        .get(identity, stored.projectId, stored.sessionId)
        .catch(() => null);
      if (existing?.status === "active" && existing.agentId === agentId)
        return stored;
    }
    const session = await agentSessions().create(identity, home, {
      agentId,
      title: "Assistant",
      source: "desktop",
    });
    // It stays on this computer and out of other chats' reach, as an
    // incognito chat does, should its project ever join a server.
    incognito.set(session.id, true);
    const ref = { projectId: home, sessionId: session.id };
    prefs(profileId).save({
      assistantSession: ref,
      assistantHeardThrough: null,
    });
    return ref;
  };

  /**
   * The chat a request talks to, and whose voice it speaks in; none for
   * dictation, which writes wherever the person types.
   */
  const resolve = async (
    profileId: string,
    request: VoiceRequest,
  ): Promise<{ ref: VoiceSessionRef; voiceOf: string | null } | null> => {
    if (request.kind === "dictation") return null;
    const ref =
      request.kind === "assistant"
        ? await assistantChat(profileId, request.projectId)
        : { projectId: request.projectId, sessionId: request.sessionId };
    const { agentId } = await agentSessions().get(
      identity,
      ref.projectId,
      ref.sessionId,
    );
    // The built-in assistant speaks in the default voice; any other agent
    // in its own, when it has one.
    const assistant = agentId ? parseAssistantAgentId(agentId) : null;
    return {
      ref,
      voiceOf: assistant
        ? assistant.builtIn
          ? null
          : assistant.agentId
        : (agentId ?? null),
    };
  };

  /**
   * A live voice starts talking with a chat, in its agent's voice, or
   * dictating: then no chat hears of voice, and the person sends what they
   * said, edited or not, as typed text.
   */
  const connect = async (
    voice: ActiveVoice,
    request: VoiceRequest,
    resolved: { ref: VoiceSessionRef; voiceOf: string | null } | null,
  ) => {
    const profileId = voice.profileId;
    // Here the server is up: its agents hear of voice and can end it.
    state.current?.agentRegistry.setVoice({ talking, sight, stopListening });
    send(voice, { type: "dictation", enabled: resolved === null });
    if (!resolved) {
      voice.dictating = { stretches: new Map(), typedInApp: 0 };
      update(voice, { target: targetOf(request), dictation: true });
      watchSend();
      handOver(voice);
      await follow(voice, prefs(profileId).load());
      return;
    }
    const { ref, voiceOf } = resolved;
    const assistant = request.kind === "assistant";
    voice.voiceOf = voiceOf;
    voice.applied.voice = agentVoice(prefs(profileId).load(), voiceOf);
    send(voice, { type: "voice", voice: voice.applied.voice });
    const sessions = agentSessions();
    voice.conversation = new VoiceConversation(ref, {
      sessions: {
        get: async (target) =>
          voiceChatOf(
            (await sessions.get(identity, target.projectId, target.sessionId))
              .snapshot,
          ),
        send: async (target, { text, dispatch }) => {
          const receipt = await sessions.command(
            identity,
            target.projectId,
            target.sessionId,
            { type: "send", commandId: randomUUID(), text, dispatch },
          );
          if (receipt.status === "rejected")
            throw new Error(
              receipt.error?.message ?? "The message was refused",
            );
          const { itemId, turnId, mode } = receipt.result ?? {};
          return {
            itemId: typeof itemId === "string" ? itemId : null,
            turnId: typeof turnId === "string" ? turnId : null,
            mode: typeof mode === "string" ? mode : null,
          };
        },
        interrupt: (target) =>
          sessions.interrupt(identity, target.projectId, target.sessionId),
      },
      speech: {
        // Speaking from the moment it is asked for: the worker says when
        // it is spoken, or cut off, whatever happens to it.
        speak: (id, text) => {
          if (!text.trim()) return;
          voice.speaking.add(id);
          send(voice, { type: "speak", id, text });
          update(voice);
        },
        cue: () => send(voice, { type: "cue" }),
        stopSpeaking: () => send(voice, { type: "stop-speaking" }),
      },
      onBusy: (busy) => {
        voice.busy = busy;
        update(voice);
      },
      onError: (message) => void stop(message),
      // The assistant's news, heard or not, outlives voice; a chat's
      // replies from before voice began are just its history.
      ...(assistant
        ? {
            heardThrough: prefs(profileId).load().assistantHeardThrough,
            onHeard: (messageId: string) =>
              prefs(profileId).save({ assistantHeardThrough: messageId }),
          }
        : {}),
    });
    if (assistant) news.delete(profileId);
    update(voice, { target: targetOf(request), dictation: false });
    // What the person missed is said first; what they said meanwhile
    // goes to the chat after it.
    const conversation = voice.conversation;
    voice.catchingUp = conversation;
    try {
      await conversation.start();
    } finally {
      if (voice.catchingUp === conversation) voice.catchingUp = null;
    }
    handOver(voice);
    update(voice);
    // Choices made while voice was starting apply now.
    await follow(voice, prefs(profileId).load());
  };

  /** What was heard while voice reached its chat goes to it now. */
  const handOver = (voice: ActiveVoice) => {
    for (const event of voice.early.splice(0)) onWorkerEvent(voice, event);
  };

  /**
   * The audio page moves to another microphone: it opens anew, with a new
   * port the worker takes. One move at a time, so the worker's port is
   * always the live microphone's.
   */
  const moveMicrophone = (voice: ActiveVoice, microphone: string | null) => {
    voice.moving = voice.moving
      .then(() => {
        const page = voice.audioWindow;
        if (active !== voice || !page || page.isDestroyed()) return;
        connectAudio(page, voice.worker, { microphone, listen: true });
      })
      .catch((cause: unknown) => {
        if (active === voice)
          void stop(cause instanceof Error ? cause.message : String(cause));
      });
    return voice.moving;
  };

  /** A live voice follows the profile's choices as they change. */
  const follow = async (voice: ActiveVoice, stored: AppPrefs) => {
    if (active !== voice || !connected(voice) || voice.ending) return;
    const was = voice.applied;
    const now = appliedOf(stored, voice.voiceOf);
    voice.applied = now;
    if (now.voice !== was.voice)
      send(voice, { type: "voice", voice: now.voice });
    if (JSON.stringify(now.voiceprint) !== JSON.stringify(was.voiceprint)) {
      send(voice, { type: "voiceprint", voiceprint: now.voiceprint });
      if (!now.voiceprint) update(voice, { learning: false });
    }
    const last = lastRequests.get(voice.profileId);
    if (
      now.assistant !== was.assistant &&
      voice.live.target?.kind === "assistant" &&
      last
    )
      void retarget(voice, last);
    if (now.microphone !== was.microphone)
      await moveMicrophone(voice, now.microphone);
  };

  const onWorkerEvent = (voice: ActiveVoice, event: VoiceWorkerEvent) => {
    if (active !== voice) return;
    switch (event.type) {
      case "speech-start":
        voice.hearing = true;
        see(voice, event.segment);
        break;
      case "speech-end":
        voice.hearing = false;
        break;
      case "utterance":
        if (!voice.conversation || voice.catchingUp) {
          if (!connected(voice) || voice.catchingUp) voice.early.push(event);
          return;
        }
        void heard(
          voice,
          voice.conversation,
          event.text,
          sightFor(voice.sights, event.segment),
        );
        break;
      case "dictation":
        if (!voice.dictating) {
          if (!connected(voice)) voice.early.push(event);
          return;
        }
        dictate(voice, voice.dictating, event);
        return;
      case "speaking":
        voice.speaking.add(event.id);
        if (reading?.id === event.id) reading.preparing = false;
        break;
      case "spoken":
        voice.speaking.delete(event.id);
        if (reading?.id === event.id) reading = null;
        voice.conversation?.said(event.id);
        break;
      case "failed":
        void stop(event.message);
        return;
      case "microphone":
        voice.microphone = event.label;
        settleQuiet();
        return;
      case "levels":
        // Every frame of it animates in the windows; no status changes.
        for (const window of BrowserWindow.getAllWindows())
          if (
            !window.isDestroyed() &&
            !isAudioWindow(window) &&
            windows.profileFor(window.webContents) === voice.profileId
          )
            window.webContents.send("catamorphic:voice-levels", {
              at: event.at,
              frameMs: event.frameMs,
              levels: event.levels,
              ...(event.reset ? { reset: true } : {}),
            });
        return;
      case "learned":
        voice.applied.voiceprint = event.voiceprint;
        prefs(voice.profileId).save({
          voiceprint: { model: VOICEPRINT_MODEL, vector: event.voiceprint },
        });
        send(voice, { type: "speak", id: "learned", text: LEARNED_REPLY });
        update(voice, { learning: false });
        return;
      case "finished":
        if (voice.finishing !== undefined) void stop();
        return;
      case "unheard":
        // A voice started by holding, held again and let go with nothing
        // said, has nothing left to do: it goes now rather than idling.
        if (
          !voice.handsFree &&
          !voice.busy &&
          !voice.ending &&
          voice.speaking.size === 0 &&
          press?.profileId !== voice.profileId
        ) {
          void stop();
          return;
        }
        break;
      case "ignored":
      case "barge-in":
      case "ready":
        break;
    }
    update(voice);
  };

  /**
   * What the person sees as they start talking (ADR 0265), taken now since
   * the screen often changes while they talk and once they finish: the
   * project in front of the Work window they are in, Work's screen for the
   * chat voice talks with, the app in front when it is not Work (its name
   * and its window's, ADR 0236), and a picture. Dictation keeps nothing:
   * no chat hears of it.
   */
  const see = (voice: ActiveVoice, segment: number) => {
    if (voice.dictating || voice.live.dictation || voice.live.learning) return;
    const latest = [...voice.sights.values()].at(-1);
    if (latest && Date.now() - latest.at < SIGHT_REUSE_MS) {
      voice.sights.set(segment, latest);
      return;
    }
    const inWork = workInFront();
    const focused = BrowserWindow.getFocusedWindow();
    // The window in front, else the one they picked in the bubble's menu,
    // else the last one they were in.
    const window =
      focused && ofProfile(focused, voice.profileId)
        ? focused
        : ((voice.windowPicked ? voiceWindow(voice) : null) ??
          windowFor(voice.profileId));
    const projectId = windowProject(window, voice.profileId);
    const target = voice.live.target;
    const chat = target?.kind === "chat" ? target : null;
    const screenOf = chat?.projectId ?? projectId;
    const registry = state.current?.agentRegistry;
    voice.sights.set(segment, {
      at: Date.now(),
      projectId,
      app:
        !inWork && systemKeys?.running
          ? systemKeys.front()
          : Promise.resolve(null),
      screen:
        screenOf && registry
          ? registry
              .screenNow(
                screenOf,
                voice.conversation?.ref.sessionId ?? chat?.sessionId,
              )
              .catch(() => null)
          : Promise.resolve(null),
      picture: takePicture(window, inWork).catch(() => null),
    });
    // Speech that never became words leaves its sight behind: a few at most.
    for (const taken of [...voice.sights.keys()].slice(0, -SIGHTS_KEPT))
      voice.sights.delete(taken);
  };

  /**
   * What the person said goes to the chat, with what they saw as they
   * started saying it, kept for its turn before the chat reads it.
   */
  const heard = async (
    voice: ActiveVoice,
    conversation: VoiceConversation,
    text: string,
    seen: Sight | null,
  ) => {
    const sight: SpokenSight | null =
      seen && !isStopCommand(text)
        ? { ...seen, said: text, heardAt: Date.now() }
        : null;
    if (sight) spoken.set(conversation.ref.sessionId, sight);
    if (active !== voice || voice.conversation !== conversation) return;
    const delivery = await conversation.heard(text);
    // What they saw describes the turn this message went to, or, steered
    // into one that ends without reading it, the turn it runs as then.
    if (sight && delivery?.turnId)
      sight.turnIds = [
        delivery.turnId,
        ...(delivery.mode === "steer" && delivery.itemId
          ? [steeredTurnId(delivery.turnId, delivery.itemId)]
          : []),
      ];
  };

  /**
   * The text field each profile's person last typed in, in its windows or
   * their pages: where dictation writes while Work is in front.
   */
  const lastFields = new Map<string, WebFrameMain>();
  const onFieldFocus = (event: Electron.IpcMainEvent) => {
    const frame = event.senderFrame;
    if (!frame) return;
    // A page's profile is its window's.
    const contents = event.sender.hostWebContents ?? event.sender;
    const profileId = windows.profileFor(contents);
    lastFields.set(profileId, frame);
    const voice = active;
    if (voice?.profileId === profileId && voice.dictating)
      settleElsewhere(voice.dictating, frame);
  };
  /**
   * The person moved to a field in another page mid-stretch: what showed
   * stays where it was, settled, and the rest of that stretch is theirs.
   */
  const settleElsewhere = (dictation: Dictation, frame: WebFrameMain) => {
    for (const known of dictation.stretches.values()) {
      const { sink } = known;
      if (sink.kind !== "field" || sameFrame(sink.frame, frame)) continue;
      known.sink = { kind: "settled" };
      if (sink.frame.isDestroyed()) continue;
      const words: VoiceDictation = {
        segment: known.stretch,
        text: known.text,
        final: true,
      };
      sink.frame.send("catamorphic:voice-dictation", words);
    }
  };
  ipcMain.on("catamorphic:voice-field-focus", onFieldFocus);

  /**
   * Where a stretch of dictation goes, settled as its words first come:
   * while Work is in front, or voice cannot type into other apps, the
   * field the person last typed in; else the app in front, where its
   * cursor is.
   */
  const sinkFor = (
    voice: ActiveVoice,
    dictation: Dictation,
  ): DictationSink | null => {
    if (!workInFront() && systemKeys?.running)
      return { kind: "app", spaced: dictation.typedInApp > 0 };
    const field = lastFields.get(voice.profileId);
    return field && !field.isDestroyed()
      ? { kind: "field", frame: field }
      : null;
  };

  const dictate = (
    voice: ActiveVoice,
    dictation: Dictation,
    event: Extract<VoiceWorkerEvent, { type: "dictation" }>,
  ) => {
    let known = dictation.stretches.get(event.segment);
    if (!known) {
      // A stretch said and over at once never showed: nothing to take back.
      if (event.final && !event.text) return;
      const sink = sinkFor(voice, dictation);
      if (!sink) return;
      known = { sink, stretch: ++stretches, text: "" };
      dictation.stretches.set(event.segment, known);
      if (sink.kind === "app") dictation.typedInApp += 1;
    }
    known.text = event.text;
    const { sink, stretch } = known;
    if (event.final) dictation.stretches.delete(event.segment);
    if (sink.kind === "settled") return;
    if (sink.kind === "app") {
      systemKeys?.dictate(
        stretch,
        sink.spaced && event.text ? ` ${event.text}` : event.text,
        event.final,
      );
      return;
    }
    if (sink.frame.isDestroyed()) return;
    const words: VoiceDictation = {
      segment: stretch,
      text: event.text,
      final: event.final,
    };
    sink.frame.send("catamorphic:voice-dictation", words);
  };

  /**
   * Dictation's stretches still open when voice stops or moves on: the
   * words they showed are what was said, and stay, settled.
   */
  const settleDictation = (voice: ActiveVoice) => {
    const dictation = voice.dictating;
    if (!dictation) return;
    for (const [segment, { text }] of [...dictation.stretches])
      dictate(voice, dictation, {
        type: "dictation",
        segment,
        text,
        final: true,
      });
  };

  /**
   * Voice turns off where it was on. Dictation first hears what the
   * person is still saying and writes it (ADR 0236), then stops.
   */
  const turnOff = (voice: ActiveVoice) => {
    if (!voice.dictating || voice.finishing !== undefined) {
      void stop();
      return;
    }
    voice.ending = true;
    voice.finishing = setTimeout(() => {
      if (active === voice) void stop();
    }, FINISH_MS);
    send(voice, { type: "finish" });
    update(voice);
  };

  /**
   * The person sent what they dictated (ADR 0236): dictation listening on
   * its own ends with it. A held voice ends as it is let go.
   */
  const dictationSent = () => {
    const voice = active;
    if (voice?.dictating && voice.handsFree) void stop();
  };
  ipcMain.on("catamorphic:voice-dictation-sent", dictationSent);

  /**
   * Learning the voice print: a spoken prompt, then the next few seconds
   * the person speaks (never the prompt itself) are their voice.
   */
  const beginLearning = (voice: ActiveVoice) => {
    send(voice, { type: "speak", id: "learn", text: LEARN_PROMPT });
    send(voice, { type: "learn" });
    update(voice, { learning: true });
  };

  /**
   * Voice starts. Nothing the person says is lost to loading (ADR 0236):
   * the microphone opens as the models load, and the worker keeps what it
   * hears, and the presses that came with it, until it can hear them.
   */
  const start = async (
    profileId: string,
    request: VoiceRequest,
    options: { handsFree: boolean; learn?: boolean; window?: number },
  ) => {
    errors.delete(profileId);
    if (request.kind !== "dictation") lastRequests.set(profileId, request);
    // A reply being read gives back the worker and page it borrowed.
    endReading();
    const warm = takeWarm();
    const worker = warm.worker;
    const voice: ActiveVoice = {
      profileId,
      worker,
      detach: () => {},
      // A warm audio page is this voice's from the start: however the
      // start ends, it rests again with the worker.
      audioWindow: warm.audio,
      conversation: null,
      dictating: null,
      voiceOf: null,
      hearing: false,
      speaking: new Set(),
      busy: false,
      ending: false,
      handsFree: options.handsFree,
      early: [],
      catchingUp: null,
      sights: new Map(),
      window: options.window ?? windowFor(profileId)?.id ?? null,
      windowPicked: options.window !== undefined,
      idle: undefined,
      finishing: undefined,
      live: {
        phase: "preparing",
        target: targetOf(request),
        download: null,
        learning: false,
        dictation: request.kind === "dictation",
        handsFree: options.handsFree,
      },
      applied: appliedOf(prefs(profileId).load(), null),
      moving: Promise.resolve(),
      microphone: null,
    };
    active = voice;
    publish();
    // Held as voice starts: what is said from now is the person's.
    if (press?.profileId === profileId)
      send(voice, { type: "hold", held: true });
    const ready = new Promise<void>((resolve, reject) => {
      const onMessage = (event: VoiceWorkerEvent) => {
        if (event.type === "ready") resolve();
        else if (event.type === "failed") reject(new Error(event.message));
        onWorkerEvent(voice, event);
      };
      const onExit = (code: number) => {
        reject(new Error(`The speech worker stopped (exit ${code}).`));
        if (active === voice)
          void stop(`The speech worker stopped (exit ${code}).`);
      };
      worker.on("message", onMessage);
      worker.once("exit", onExit);
      voice.detach = () => {
        worker.off("message", onMessage);
        worker.off("exit", onExit);
      };
    });
    // Turning voice off mid-start rests the worker; nobody awaits then.
    ready.catch(() => {});
    // Each step can outlast a press that turns voice off again.
    const live = () => active === voice;
    try {
      const fake = fakeUtterances
        ? fakeUtterances[fakeStarts++ % fakeUtterances.length]
        : undefined;
      const paths =
        fake === undefined
          ? await models.ensure((download) => update(voice, { download }))
          : null;
      if (!live()) return;
      update(voice, { download: null });
      const stored = prefs(profileId).load();
      voice.applied = appliedOf(stored, null);
      send(voice, {
        type: "start",
        speech: paths
          ? { kind: "models", paths, voice: voice.applied.voice }
          : { kind: "fake", utterance: fake ?? "" },
        voiceprint: voice.applied.voiceprint,
        handsFree: voice.handsFree,
        dictation: request.kind === "dictation",
      });
      // The microphone opens while the models load and the chat is found.
      const microphone = (async () => {
        if (fake === undefined) await ensureMicrophone();
        if (!live()) return;
        const window = voice.audioWindow ?? (await openAudioWindow(audioGone));
        if (!live()) {
          if (window !== voice.audioWindow) window.destroy();
          return;
        }
        voice.audioWindow = window;
        connectAudio(window, worker, {
          microphone: stored.voiceMicrophone,
          listen: true,
        });
      })();
      const [resolved] = await Promise.all([
        resolve(profileId, request),
        microphone,
        ready,
      ]);
      if (!live()) return;
      await connect(voice, request, resolved);
      if (options.learn) beginLearning(voice);
    } catch (cause) {
      if (live())
        await stop(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /** A live voice moves to another chat, or to dictation: the models stay. */
  const retarget = async (voice: ActiveVoice, request: VoiceRequest) => {
    if (request.kind !== "dictation")
      lastRequests.set(voice.profileId, request);
    send(voice, { type: "stop-speaking" });
    voice.conversation?.stop();
    voice.conversation = null;
    settleDictation(voice);
    voice.dictating = null;
    voice.busy = false;
    voice.early = [];
    // The microphone pressed lights at once; a failure is its to show.
    update(voice, {
      target: targetOf(request),
      dictation: request.kind === "dictation",
    });
    try {
      const resolved = await resolve(voice.profileId, request);
      if (active !== voice) return;
      await connect(voice, request, resolved);
    } catch (cause) {
      if (active === voice)
        await stop(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /**
   * A microphone or a shortcut went down (ADR 0236): voice hears the
   * person from now. Pressed where voice is already on, it holds; pressed
   * elsewhere, voice moves there, or starts, hearing only while held until
   * the press turns out to be a tap.
   */
  const pressDown = (
    profileId: string,
    request: VoiceRequest,
    { key = false, helper = false }: { key?: boolean; helper?: boolean } = {},
  ) => {
    if (press) return;
    // Dictation writing its last words is off already: a press there
    // stops it at once, and starts nothing.
    if (
      active?.profileId === profileId &&
      active.finishing !== undefined &&
      sameVoiceTarget(active.live.target, targetOf(request))
    ) {
      press = { profileId, at: Date.now(), wasOn: true, key, helper };
      void stop();
      return;
    }
    const voice =
      active?.profileId === profileId && !active.ending ? active : null;
    const same =
      !!voice && sameVoiceTarget(voice.live.target, targetOf(request));
    press = { profileId, at: Date.now(), wasOn: same, key, helper };
    if (voice) clearTimeout(voice.idle);
    if (voice && same) {
      send(voice, { type: "hold", held: true });
      return;
    }
    if (voice && connected(voice)) {
      // What was said for where voice was goes no further.
      send(voice, { type: "forget" });
      voice.handsFree = false;
      send(voice, { type: "hands-free", enabled: false });
      send(voice, { type: "hold", held: true });
      void retarget(voice, request);
      return;
    }
    void stop().then(() => start(profileId, request, { handsFree: false }));
  };

  /**
   * The press came up. A tap turns voice on, listening on its own, or off
   * where it already was; a hold is heard at once, and a voice started by
   * it goes off once idle.
   */
  const pressUp = ({ heldMs }: { heldMs?: number } = {}) => {
    const done = press;
    press = null;
    if (!done) return;
    if (done.key) askForEveryApp(done.profileId);
    const voice = active?.profileId === done.profileId ? active : null;
    if (!voice) return;
    const tap = (heldMs ?? Date.now() - done.at) < TAP_MS;
    if (tap && done.wasOn) {
      turnOff(voice);
      return;
    }
    if (tap) {
      send(voice, { type: "hold", held: false, discard: true });
      voice.handsFree = true;
      send(voice, { type: "hands-free", enabled: true });
      watchSend();
    } else send(voice, { type: "hold", held: false });
    update(voice);
  };

  /** What a press asks of voice, for a profile; null when nothing can. */
  const requestOf = (
    profileId: string,
    pressed: VoicePress,
  ): VoiceRequest | null => {
    if (pressed.action === "dictate")
      return pressed.sessionId
        ? { kind: "dictation", sessionId: pressed.sessionId }
        : { kind: "dictation" };
    const stored = prefs(profileId).load();
    // The assistant's own chat, from its composer, is the assistant.
    if (
      pressed.action === "talk-to-chat" &&
      pressed.projectId &&
      pressed.sessionId &&
      pressed.sessionId !== stored.assistantSession?.sessionId
    )
      return {
        kind: "chat",
        projectId: pressed.projectId,
        sessionId: pressed.sessionId,
      };
    if (pressed.action === "talk-to-chat" && !pressed.sessionId) return null;
    const projectId =
      pressed.projectId ??
      stored.lastProjectId ??
      stored.assistantSession?.projectId;
    return projectId ? { kind: "assistant", projectId } : null;
  };

  const pressFrom = (
    profileId: string,
    pressed: VoicePress,
    options: { key?: boolean; helper?: boolean } = {},
  ) => {
    const request = requestOf(profileId, pressed);
    if (request) {
      pressDown(profileId, request, options);
      return;
    }
    errors.set(profileId, {
      message:
        pressed.action === "talk-to-chat"
          ? "Open a chat to talk to it."
          : "Open a project to talk to Work.",
      target: null,
    });
    publish();
  };

  // While voice is off, a session the assistant started can still report
  // back: the assistant's chat wakes, answers, and the person sees it like
  // any chat's reply. The microphone shows that there is news to hear.
  const checkNews = async () => {
    const profileIds = new Set(
      workWindows().map((window) => windows.profileFor(window.webContents)),
    );
    let changed = false;
    for (const profileId of profileIds) {
      if (
        active?.profileId === profileId &&
        active.live.target?.kind === "assistant"
      )
        continue;
      const stored = prefs(profileId).load();
      const ref = stored.assistantSession;
      const detail = ref
        ? await state.current?.catamorphic.core.agentSessions
            ?.get(identity, ref.projectId, ref.sessionId)
            .catch(() => null)
        : null;
      // A chat of an assistant since replaced has no news for this one.
      const assistant =
        ref && detail?.status === "active"
          ? assistantFor(profileId, ref.projectId)
          : null;
      const unheard =
        detail?.status === "active" &&
        !!assistant &&
        detail.agentId === assistantAgentId(assistant) &&
        unheardReplies(
          voiceChatOf(detail.snapshot).messages,
          stored.assistantHeardThrough,
        ).length > 0;
      if (unheard === news.has(profileId)) continue;
      if (unheard) news.add(profileId);
      else news.delete(profileId);
      changed = true;
    }
    if (changed) publish();
  };
  let checking = false;
  const newsTimer = setInterval(() => {
    if (checking) return;
    checking = true;
    void checkNews()
      .catch((cause: unknown) =>
        console.warn("[voice] news check failed:", cause),
      )
      .finally(() => {
        checking = false;
      });
  }, NEWS_POLL_MS);
  newsTimer.unref();

  // The audio page outlives no workspace: closing the last window stops
  // voice, though a workspace window only hides on close. Hiding Work or
  // minimizing it keeps voice going, hands-free.
  const onWindowCreated = (_event: unknown, window: BrowserWindow) => {
    const stopUnlessShown = () => {
      if (isAudioWindow(window) || bubble.owns(window)) return;
      const shown = workWindows().some(
        (candidate) => candidate !== window && candidate.isVisible(),
      );
      if (!shown && active) void stop();
    };
    window.on("close", stopUnlessShown);
    window.once("closed", stopUnlessShown);
  };
  app.on("browser-window-created", onWindowCreated);
  // Work coming in front, or going behind another app, moves the bubble.
  app.on("browser-window-focus", refreshBubble);
  // Focus moving between Work's windows blurs one before the next is
  // focused: the bubble waits to see whether Work is still in front.
  let bubbleBlur: ReturnType<typeof setTimeout> | undefined;
  const onBubbleBlur = () => {
    clearTimeout(bubbleBlur);
    bubbleBlur = setTimeout(refreshBubble, 100);
  };
  app.on("browser-window-blur", onBubbleBlur);
  app.on("did-become-active", refreshBubble);
  app.on("did-resign-active", refreshBubble);

  ipcMain.handle("catamorphic:voice-get-status", (event) =>
    statusFor(windows.profileFor(event.sender)),
  );
  // Resolve at once: the status events say when it plays and ends.
  ipcMain.handle("catamorphic:voice-read-aloud", (event, input: unknown) => {
    void readAloud(
      windows.profileFor(event.sender),
      readAloudSchema.parse(input),
    );
  });
  // Resolve at once: preparing can take a first download, and the status
  // events carry the rest.
  ipcMain.handle("catamorphic:voice-press", (event, pressed: VoicePress) => {
    pressFrom(windows.profileFor(event.sender), pressed);
  });
  // A microphone measures its own press: the main process may answer late.
  ipcMain.handle("catamorphic:voice-release", (_event, input: unknown) =>
    pressUp({ heldMs: heldMsOf(input) }),
  );
  // Learning starts voice when it is off: it needs the microphone.
  ipcMain.handle(
    "catamorphic:voice-learn",
    async (event, input: { projectId?: string; sessionId?: string }) => {
      const profileId = windows.profileFor(event.sender);
      const voice = active;
      if (voice?.profileId === profileId && connected(voice) && !voice.ending) {
        beginLearning(voice);
        return;
      }
      if (voice?.profileId === profileId && !voice.ending) return;
      const request = requestOf(profileId, {
        action: input.sessionId ? "talk-to-chat" : "talk-to-work",
        ...input,
      });
      if (!request) {
        errors.set(profileId, {
          message: "Open a project to talk to Work.",
          target: null,
        });
        publish();
        return;
      }
      await stop();
      void start(profileId, request, { handsFree: true, learn: true });
    },
  );

  /** The chat in front of each window, for "Talk to this chat". */
  const frontChats = new Map<
    number,
    { projectId: string; sessionId: string } | null
  >();
  let lastFrontChat: { projectId: string; sessionId: string } | null = null;
  const onFrontChat = (
    event: Electron.IpcMainEvent,
    chat: { projectId: string; sessionId: string } | null,
  ) => {
    frontChats.set(event.sender.id, chat);
    if (chat) lastFrontChat = chat;
  };
  ipcMain.on("catamorphic:voice-front-chat", onFrontChat);

  /** What a voice shortcut asks, from a window or from any app. */
  const keyPress = (
    action: VoiceAction,
    contents: WebContents | null,
  ): VoicePress => {
    const chat =
      (contents ? frontChats.get(contents.id) : undefined) ?? lastFrontChat;
    if (action === "dictate") return { action };
    if (action === "talk-to-chat")
      return chat ? { action, ...chat } : { action };
    return chat ? { action, projectId: chat.projectId } : { action };
  };

  /** Each profile's voice shortcuts, kept until they change. */
  const shortcutsOf = new Map<string, Partial<Record<VoiceAction, string>>>();
  const shortcutsFor = (profileId: string) => {
    let shortcuts = shortcutsOf.get(profileId);
    if (!shortcuts) {
      const bindings = profileConfig.forProfile(profileId).keybindings.load();
      shortcuts = Object.fromEntries(
        VOICE_ACTIONS.flatMap((action) =>
          bindings[action] ? [[action, bindings[action]]] : [],
        ),
      );
      shortcutsOf.set(profileId, shortcuts);
    }
    return shortcuts;
  };

  // Voice's shortcuts in Work's windows and pages.
  const stopVoiceKeys = listenForVoiceKeys({
    keysFor: (contents) => {
      const profileId = windows.profileFor(contents);
      return { profileId, shortcuts: shortcutsFor(profileId) };
    },
    down: (profileId, action, contents) =>
      pressFrom(profileId, keyPress(action, contents), { key: true }),
    up: () => pressUp(),
  });

  /** Whose shortcuts work in every app: the profile of the window last used. */
  /**
   * The window of Work's the person was last in: whose shortcuts work in
   * every app, and whose chat is "this chat".
   */
  const lastWorkWindow = () =>
    recentWindows.find((window) => !window.isDestroyed()) ?? null;
  const keysProfile = (): string | null => {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && workWindows().includes(focused))
      return windows.profileFor(focused.webContents);
    const recent = lastWorkWindow();
    if (recent) return windows.profileFor(recent.webContents);
    const open = workWindows().map((window) =>
      windows.profileFor(window.webContents),
    );
    const last = profiles.lastActiveProfile().id;
    return open.includes(last) ? last : (open[0] ?? null);
  };

  /**
   * A window's assistant: its profile, the project its chat is kept in and
   * its name; null when the window's profile has none to talk to. The
   * bubble's menu shows it, and moving there starts it, so the two agree.
   */
  const windowAssistant = (
    window: BrowserWindow,
  ): { profileId: string; home: string; name: string } | null => {
    const profileId = windows.profileFor(window.webContents);
    let home: string;
    try {
      home = assistantHome(profileId, windowProject(window, profileId) ?? "");
    } catch {
      return null;
    }
    const assistant = assistantFor(profileId, home);
    if (!assistant) return null;
    const name = assistant.builtIn
      ? "Work"
      : (profileConfig.forProfile(profileId).agents.get(assistant.agentId)
          ?.name ?? "Work");
    return { profileId, home, name };
  };

  /**
   * The workspace windows whose assistant the bubble can talk to, the last
   * one the person was in first: while voice talks to the assistant.
   */
  const windowChoices = (): VoiceWindowChoice[] => {
    const voice = active;
    if (voice?.live.target?.kind !== "assistant") return [];
    const open = [
      ...recentWindows,
      ...BrowserWindow.getAllWindows().filter(
        (window) => !recentWindows.includes(window),
      ),
    ].filter(
      (window) =>
        !window.isDestroyed() &&
        deps.isWorkspace(window) &&
        (window.isVisible() || window.isMinimized()),
    );
    const profileIds = new Set(
      open.map((window) => windows.profileFor(window.webContents)),
    );
    const current = voiceWindow(voice);
    return open.map((window) => {
      const profileId = windows.profileFor(window.webContents);
      const profileName =
        profileIds.size > 1 ? profiles.get(profileId)?.name : undefined;
      return {
        id: window.id,
        title: window.getTitle() || "Work",
        assistant: windowAssistant(window)?.name ?? null,
        ...(profileName ? { profile: profileName } : {}),
        current: window === current,
      };
    });
  };

  /**
   * Voice moves to another window's assistant, as the person picked in the
   * bubble's menu, whenever they like. The bubble stays up and takes the
   * window's colours; in another profile, voice starts again with its
   * assistant, and the one it leaves is paused: it stops speaking, its work
   * goes on, and what it says meanwhile is news for when voice comes back
   * to it (a reply cut off is said again then). The window picked is where
   * the person is from now: its profile's shortcuts, and its chat for
   * "Talk to this chat".
   */
  const moveToWindow = async (windowId: number) => {
    const voice = active;
    if (voice?.live.target?.kind !== "assistant") return;
    const window = BrowserWindow.fromId(windowId);
    if (!window || window.isDestroyed() || !deps.isWorkspace(window)) return;
    const assistant = windowAssistant(window);
    if (!assistant) return;
    recentWindows = [
      window,
      ...recentWindows.filter(
        (other) => other !== window && !other.isDestroyed(),
      ),
    ];
    refreshSystemKeys();
    if (assistant.profileId === voice.profileId) {
      voice.window = windowId;
      voice.windowPicked = true;
      publish();
      return;
    }
    switching = true;
    try {
      await stop();
    } finally {
      switching = false;
    }
    await start(
      assistant.profileId,
      { kind: "assistant", projectId: assistant.home },
      { handsFree: voice.handsFree, window: windowId },
    );
  };

  /**
   * Voice's shortcuts in every app (ADR 0236), on macOS: the helper on an
   * event tap, once Work is allowed in Accessibility. It also types
   * dictation into the app in front, and names that app for the chat.
   */
  const systemKeys =
    process.platform === "darwin"
      ? new SystemKeys({
          helperPath: app.isPackaged
            ? path.join(process.resourcesPath, "..", "MacOS", "voice-keys")
            : path.join(
                app.getAppPath(),
                "native",
                "voice-keys",
                "bin",
                "voice-keys",
              ),
          onEvent: (event) => {
            // Work's own pages say when what they dictated is sent.
            if (event.type === "send") {
              if (!workInFront() && active?.dictating?.typedInApp)
                dictationSent();
            } else if (event.type === "up") pressUp();
            else {
              const action = VOICE_ACTIONS.find(
                (candidate) => candidate === event.name,
              );
              const profileId = keysProfile();
              // The helper hears the keys in Work too: "this chat" is the
              // one in the window the person is, or was last, in.
              const window = lastWorkWindow();
              if (action && profileId)
                pressFrom(
                  profileId,
                  keyPress(action, window?.webContents ?? null),
                  { helper: true },
                );
            }
          },
          onUntrusted: () => setKeysState("needs-permission"),
          // Focusing a window of Work's starts it again; a key it held
          // is let go.
          onGone: () => {
            if (keysState === "everywhere") setKeysState("app");
            if (press?.helper) pressUp();
          },
        })
      : null;
  let keysState: VoiceKeysState = systemKeys ? "app" : "unsupported";
  const setKeysState = (next: VoiceKeysState) => {
    if (keysState === next) return;
    keysState = next;
    for (const window of workWindows())
      window.webContents.send("catamorphic:voice-keys", keysState);
  };
  const refreshSystemKeys = () => {
    if (!systemKeys || disposed) return;
    const profileId = keysProfile();
    const shortcuts = profileId ? shortcutsFor(profileId) : {};
    // A key the helper held is let go with it.
    const stopKeys = () => {
      systemKeys.stop();
      if (press?.helper) pressUp();
    };
    if (Object.keys(shortcuts).length === 0) {
      stopKeys();
      setKeysState("app");
      return;
    }
    if (!systemPreferences.isTrustedAccessibilityClient(false)) {
      stopKeys();
      setKeysState("needs-permission");
      return;
    }
    systemKeys.watch(shortcuts);
    watchSend();
    setKeysState("everywhere");
  };
  /**
   * macOS asks once, after the person's first voice shortcut in Work, to
   * let the shortcuts work in every app; Settings asks after that.
   */
  const askForEveryApp = (profileId: string) => {
    if (keysState !== "needs-permission") return;
    if (prefs(profileId).load().voiceShortcutsAsked) return;
    prefs(profileId).save({ voiceShortcutsAsked: true });
    systemPreferences.isTrustedAccessibilityClient(true);
  };
  /** Return in the app in front ends dictation listening on its own. */
  const watchSend = () =>
    systemKeys?.watchSend(!!active?.dictating && active.handsFree);
  ipcMain.handle("catamorphic:voice-keys-status", () => keysState);

  // The bubble's page asks what it shows as it starts, and which windows'
  // assistants it can talk to; it moves the bubble when dragged. Its
  // resting spots' page asks what it shows as it starts.
  const fromBubble = (event: Electron.IpcMainInvokeEvent) =>
    bubble.pageOf(event.sender) === "bubble";
  ipcMain.handle("catamorphic:voice-bubble-state", (event) =>
    fromBubble(event) ? bubble.state() : null,
  );
  ipcMain.handle("catamorphic:voice-bubble-spots-state", (event) =>
    bubble.pageOf(event.sender) === "spots" ? bubble.spotsState() : null,
  );
  ipcMain.handle("catamorphic:voice-bubble-drag", (event, input: unknown) => {
    const drag = voiceBubbleDragSchema.safeParse(input);
    if (fromBubble(event) && drag.success) bubble.drag(drag.data);
  });
  ipcMain.handle("catamorphic:voice-bubble-windows", (event) =>
    fromBubble(event) ? windowChoices() : [],
  );
  ipcMain.handle(
    "catamorphic:voice-bubble-window",
    async (event, windowId: unknown) => {
      if (fromBubble(event) && typeof windowId === "number")
        await moveToWindow(windowId);
    },
  );
  // An embedded frame of a page asks for voice's keys as it starts, to
  // keep them from the page (its tab's host tells the top frame).
  ipcMain.handle("catamorphic:voice-keys-of-page", (event) => {
    const contents = event.sender.hostWebContents ?? event.sender;
    return Object.values(shortcutsFor(windows.profileFor(contents)))
      .filter(Boolean)
      .join("\n");
  });
  ipcMain.handle("catamorphic:voice-keys-allow", async () => {
    systemPreferences.isTrustedAccessibilityClient(true);
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    );
  });
  // Allowed in System Settings: Work notices when the person comes back.
  const onWindowFocus = (_event: unknown, window: BrowserWindow) => {
    if (workWindows().includes(window))
      recentWindows = [
        window,
        ...recentWindows.filter(
          (other) => other !== window && !other.isDestroyed(),
        ),
      ];
    refreshSystemKeys();
  };
  app.on("browser-window-focus", onWindowFocus);
  const onKeysWindow = (_event: unknown, window: BrowserWindow) => {
    if (bubble.owns(window)) return;
    window.once("closed", () => setTimeout(() => refreshSystemKeys(), 0));
    setTimeout(() => refreshSystemKeys(), 0);
  };
  app.on("browser-window-created", onKeysWindow);
  setTimeout(() => refreshSystemKeys(), 0);

  // Settings live in the profile's prefs, which windows read themselves:
  // a live voice follows them.
  profileConfig.onPrefsChanged((profileId, stored) => {
    if (disposed) return;
    const voice = active;
    if (voice?.profileId === profileId)
      void follow(voice, stored).catch((cause: unknown) =>
        console.warn("[voice] applying a setting failed:", cause),
      );
    refreshBubble();
    bubble.prefsChanged(profileId);
  });
  profileConfig.onKeybindingsChanged((profileId) => {
    shortcutsOf.delete(profileId);
    refreshSystemKeys();
  });

  // A reset closes the assistant's chat; the next start makes another.
  ipcMain.handle("catamorphic:voice-reset", async (event) => {
    const profileId = windows.profileFor(event.sender);
    if (
      active?.profileId === profileId &&
      active.live.target?.kind === "assistant"
    )
      await stop();
    const ref = prefs(profileId).load().assistantSession;
    prefs(profileId).save({
      assistantSession: null,
      assistantHeardThrough: null,
    });
    errors.delete(profileId);
    news.delete(profileId);
    publish();
    if (ref)
      await state.current?.catamorphic.core.agentSessions
        ?.close(identity, ref.projectId, ref.sessionId)
        .catch((cause: unknown) =>
          console.warn("[voice] closing the assistant's chat failed:", cause),
        );
  });

  return {
    dispose: async () => {
      disposed = true;
      spoken.clear();
      app.off("browser-window-created", onWindowCreated);
      app.off("browser-window-created", onKeysWindow);
      app.off("browser-window-focus", refreshBubble);
      app.off("browser-window-blur", onBubbleBlur);
      clearTimeout(bubbleBlur);
      app.off("did-become-active", refreshBubble);
      app.off("did-resign-active", refreshBubble);
      app.off("browser-window-focus", onWindowFocus);
      stopVoiceKeys();
      systemKeys?.stop();
      quiet?.stop();
      ipcMain.off("catamorphic:voice-field-focus", onFieldFocus);
      ipcMain.off("catamorphic:voice-dictation-sent", dictationSent);
      ipcMain.off("catamorphic:voice-front-chat", onFrontChat);
      for (const channel of [
        "catamorphic:voice-get-status",
        "catamorphic:voice-read-aloud",
        "catamorphic:voice-press",
        "catamorphic:voice-release",
        "catamorphic:voice-reset",
        "catamorphic:voice-learn",
        "catamorphic:voice-keys-status",
        "catamorphic:voice-keys-allow",
        "catamorphic:voice-bubble-menu",
        "catamorphic:voice-bubble-state",
        "catamorphic:voice-bubble-spots-state",
        "catamorphic:voice-bubble-drag",
        "catamorphic:voice-bubble-windows",
        "catamorphic:voice-bubble-window",
        "catamorphic:voice-keys-of-page",
      ])
        ipcMain.removeHandler(channel);
      clearInterval(newsTimer);
      endReading();
      await stop();
      if (resting) {
        letGo(resting);
        resting = null;
      }
      bubble.dispose();
    },
  };
}

/**
 * macOS asks once per app for the microphone; a refusal fails here with a
 * way forward rather than as silence from the audio page.
 */
async function ensureMicrophone(): Promise<void> {
  if (process.platform !== "darwin") return;
  if (systemPreferences.getMediaAccessStatus("microphone") === "granted")
    return;
  if (await systemPreferences.askForMediaAccess("microphone")) return;
  throw new Error(
    "Work cannot use the microphone. Allow it in System Settings, Privacy & Security, Microphone.",
  );
}

function sameFrame(a: WebFrameMain, b: WebFrameMain): boolean {
  return (
    a === b ||
    (!a.isDestroyed() &&
      !b.isDestroyed() &&
      a.processId === b.processId &&
      a.routingId === b.routingId)
  );
}

/** How long a press was held, as the page that saw it measured it. */
function heldMsOf(input: unknown): number | undefined {
  if (typeof input !== "object" || input === null || !("heldMs" in input))
    return undefined;
  const { heldMs } = input;
  return typeof heldMs === "number" && Number.isFinite(heldMs) && heldMs >= 0
    ? heldMs
    : undefined;
}

/** Audio pages, live, resting or opening: the person never sees them. */
const audioPages = new WeakSet<BrowserWindow>();
const isAudioWindow = (window: BrowserWindow) => audioPages.has(window);

/**
 * The audio page: a hidden window that holds the microphone (with echo
 * cancellation) and plays the agent's voice.
 */
async function openAudioWindow(
  gone: (window: BrowserWindow) => void,
): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    show: false,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: "no-user-gesture-required",
      backgroundThrottling: false,
    },
  });
  audioPages.add(window);
  window.webContents.once("render-process-gone", () => {
    gone(window);
    if (!window.isDestroyed()) window.destroy();
  });
  try {
    if (process.env.ELECTRON_RENDERER_URL)
      await window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/voice.html`);
    else
      await window.loadFile(
        path.join(import.meta.dirname, "../renderer/voice.html"),
      );
  } catch (cause) {
    window.destroy();
    throw cause;
  }
  return window;
}

/**
 * The audio page opens a microphone for the speech worker, unless it only
 * plays: their port goes straight between them, so audio never passes
 * through the main process. Whatever the page served before closes.
 */
function connectAudio(
  window: BrowserWindow,
  worker: UtilityProcess,
  input: { microphone: string | null; listen: boolean },
): void {
  const { port1, port2 } = new MessageChannelMain();
  worker.postMessage({ type: "audio" } satisfies VoiceWorkerCommand, [port1]);
  window.webContents.postMessage(VOICE_PORT_MESSAGE, input, [port2]);
}

function parseFakeUtterances(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((item) => typeof item === "string")
  )
    throw new Error(
      "CATAMORPHIC_E2E_FAKE_VOICE must be a JSON list of strings",
    );
  return parsed;
}
