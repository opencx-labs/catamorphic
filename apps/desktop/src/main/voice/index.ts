import { randomUUID } from "node:crypto";
import path from "node:path";
import { parseProjectAgentId } from "@catamorphic/core";
import {
  app,
  BrowserWindow,
  ipcMain,
  MessageChannelMain,
  systemPreferences,
  type UtilityProcess,
  utilityProcess,
} from "electron";
import type { AppPrefs } from "../../shared/app-prefs.js";
import {
  type AssistantAgent,
  agentVoice,
  assistantAgentId,
  parseAssistantAgentId,
  sameVoiceTarget,
  VOICE_OFF,
  VOICE_PORT_MESSAGE,
  type VoiceId,
  type VoiceSessionRef,
  type VoiceStatus,
  type VoiceTarget,
  type VoiceWorkerCommand,
  type VoiceWorkerEvent,
} from "../../shared/voice.js";
import type { IncognitoSessionsStore } from "../incognito-sessions.js";
import type { WindowProfileRegistry } from "../index.js";
import type { ServerState } from "../ipc.js";
import type { ProfileConfigManager } from "../profile-config.js";
import type { ProfilesStore } from "../profiles.js";
import { DESKTOP_TENANT_ID, DESKTOP_USER_ID } from "../server/boot.js";
import {
  unheardReplies,
  VoiceConversation,
  voiceChatOf,
} from "./conversation.js";
import { VoiceModelStore } from "./models.js";
import { listenForPushToTalk } from "./push-to-talk.js";

/** What voice says when it starts learning the person's voice. */
const LEARN_PROMPT =
  "Let me learn your voice. Talk to me for a few seconds, about anything, the way you normally would.";
const LEARNED_REPLY =
  "Got it. I know your voice now, and I'll only listen to you.";

/** How often the assistant's chat is checked for news while voice is off. */
const NEWS_POLL_MS = 5_000;

const identity = {
  tenantId: DESKTOP_TENANT_ID,
  externalUserId: DESKTOP_USER_ID,
};

/** Where voice was asked to talk: the assistant, from a project, or a chat. */
type VoiceRequest =
  | { kind: "assistant"; projectId: string }
  | { kind: "chat"; projectId: string; sessionId: string };

function targetOf(request: VoiceRequest): VoiceTarget {
  return request.kind === "assistant"
    ? { kind: "assistant" }
    : {
        kind: "chat",
        projectId: request.projectId,
        sessionId: request.sessionId,
      };
}

/** What a live voice is doing. */
type LiveStatus = Pick<
  VoiceStatus,
  "phase" | "target" | "download" | "learning"
>;

/** The stored choices a live voice runs with. */
interface Applied {
  voice: VoiceId;
  microphone: string | null;
  pushToTalk: boolean;
  voiceprint: number[] | null;
  assistant: string | null;
}

function appliedOf(stored: AppPrefs, voiceOf: string | null): Applied {
  return {
    voice: agentVoice(stored, voiceOf),
    microphone: stored.voiceMicrophone,
    pushToTalk: stored.voicePushToTalk,
    voiceprint: stored.voiceprint,
    assistant: stored.voiceAssistant,
  };
}

interface ActiveVoice {
  profileId: string;
  worker: UtilityProcess;
  audioWindow: BrowserWindow | null;
  conversation: VoiceConversation | null;
  /** Whose voice it speaks in: an agent's, or null for the default voice. */
  voiceOf: string | null;
  hearing: boolean;
  speaking: Set<string>;
  busy: boolean;
  live: LiveStatus;
  applied: Applied;
  /** Microphone moves, one at a time: each opens a new audio page. */
  moving: Promise<void>;
}

/**
 * Voice's main-process side (ADR 0216). One voice is live at a time, for
 * one profile: it owns the speech worker and the hidden audio window (the
 * microphone and speakers), and talks to one chat at a time, the
 * assistant's from the dock or any chat from its composer, moving between
 * them without reloading. Its settings are the profile's prefs, wherever
 * they change (Settings, a menu, the palette, the file): a live voice
 * follows them. The assistant's chat is kept there too, until a reset or
 * another assistant replaces it.
 */
export function registerVoiceSupport(deps: {
  state: ServerState;
  profileConfig: ProfileConfigManager;
  profiles: ProfilesStore;
  windows: WindowProfileRegistry;
  /** Chats kept on this computer (ADR 0062), the assistant's among them. */
  incognito: IncognitoSessionsStore;
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
  /** Why each profile's voice stopped, and what it was talking to. */
  const errors = new Map<
    string,
    { message: string; target: VoiceTarget | null }
  >();
  /** Profiles whose assistant has replies the person has not heard. */
  const news = new Set<string>();
  /** What each profile talked to last: where push to talk starts. */
  const lastRequests = new Map<string, VoiceRequest>();
  /** The profile whose push-to-talk keys are down, if any. */
  let holding: string | null = null;
  /** Each profile's push-to-talk keys; null while push to talk is off. */
  const pushToTalkKeys = new Map<string, string | null>();

  const prefs = (profileId: string) =>
    profileConfig.forProfile(profileId).prefs;

  const statusFor = (profileId: string): VoiceStatus => {
    const pending = news.has(profileId);
    if (active?.profileId === profileId)
      return { ...VOICE_OFF, ...active.live, pending };
    const error = errors.get(profileId);
    return {
      ...VOICE_OFF,
      pending,
      ...(error ? { error: error.message, target: error.target } : {}),
    };
  };

  const publish = () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window === active?.audioWindow) continue;
      window.webContents.send(
        "catamorphic:voice-status",
        statusFor(windows.profileFor(window.webContents)),
      );
    }
  };

  const update = (voice: ActiveVoice, patch: Partial<LiveStatus> = {}) => {
    if (active !== voice) return;
    const phase =
      voice.live.phase === "preparing" && !voice.conversation
        ? "preparing"
        : voice.hearing
          ? "hearing"
          : voice.speaking.size > 0
            ? "speaking"
            : voice.busy
              ? "thinking"
              : "listening";
    voice.live = { ...voice.live, phase, ...patch };
    publish();
  };

  const send = (voice: ActiveVoice, command: VoiceWorkerCommand) => {
    if (active === voice) voice.worker.postMessage(command);
  };

  const stop = async (error?: string) => {
    const voice = active;
    if (!voice) return;
    active = null;
    voice.conversation?.stop();
    voice.worker.kill();
    if (voice.audioWindow && !voice.audioWindow.isDestroyed())
      voice.audioWindow.destroy();
    if (error)
      errors.set(voice.profileId, {
        message: error,
        target: voice.live.target,
      });
    publish();
  };

  const agentSessions = () => {
    const service = state.current?.catamorphic.core.agentSessions;
    if (!service) throw new Error("Work is still starting.");
    return service;
  };

  /** Whether the person is talking with this chat by voice now. */
  const talking = (sessionId: string) =>
    active?.conversation?.ref.sessionId === sessionId;

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

  /** The chat a request talks to, and whose voice it speaks in. */
  const resolve = async (
    profileId: string,
    request: VoiceRequest,
  ): Promise<{ ref: VoiceSessionRef; voiceOf: string | null }> => {
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

  /** A live voice starts talking with a chat, in its agent's voice. */
  const connect = async (
    voice: ActiveVoice,
    request: VoiceRequest,
    { ref, voiceOf }: { ref: VoiceSessionRef; voiceOf: string | null },
  ) => {
    const profileId = voice.profileId;
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
        send: async (target, text) => {
          const receipt = await sessions.command(
            identity,
            target.projectId,
            target.sessionId,
            { type: "send", commandId: randomUUID(), text },
          );
          if (receipt.status === "rejected")
            throw new Error(
              receipt.error?.message ?? "The message was refused",
            );
        },
        interrupt: (target) =>
          sessions.interrupt(identity, target.projectId, target.sessionId),
      },
      speech: {
        speak: (id, text) => send(voice, { type: "speak", id, text }),
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
    update(voice, { target: targetOf(request) });
    await voice.conversation.start();
    update(voice);
    // Choices made while voice was starting apply now.
    await follow(voice, prefs(profileId).load());
  };

  /**
   * The audio page moves to another microphone: the worker takes the new
   * page's port. One move at a time, so the worker's port is always the
   * live page's.
   */
  const moveMicrophone = (voice: ActiveVoice, microphone: string | null) => {
    voice.moving = voice.moving
      .then(async () => {
        const previous = voice.audioWindow;
        if (active !== voice || !previous) return;
        const next = await openAudioWindow(voice.worker, microphone);
        if (active !== voice) {
          next.destroy();
          return;
        }
        voice.audioWindow = next;
        if (!previous.isDestroyed()) previous.destroy();
      })
      .catch((cause: unknown) => {
        if (active === voice)
          void stop(cause instanceof Error ? cause.message : String(cause));
      });
    return voice.moving;
  };

  /** A live voice follows the profile's choices as they change. */
  const follow = async (voice: ActiveVoice, stored: AppPrefs) => {
    if (active !== voice || !voice.conversation) return;
    const was = voice.applied;
    const now = appliedOf(stored, voice.voiceOf);
    voice.applied = now;
    if (now.voice !== was.voice)
      send(voice, { type: "voice", voice: now.voice });
    if (now.pushToTalk !== was.pushToTalk)
      send(voice, { type: "push-to-talk", enabled: now.pushToTalk });
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
        break;
      case "speech-end":
        voice.hearing = false;
        break;
      case "utterance":
        void voice.conversation?.heard(event.text);
        break;
      case "speaking":
        voice.speaking.add(event.id);
        break;
      case "spoken":
        voice.speaking.delete(event.id);
        break;
      case "failed":
        void stop(event.message);
        return;
      case "levels":
        // Every frame of it animates in the windows; no status changes.
        for (const window of BrowserWindow.getAllWindows())
          if (
            !window.isDestroyed() &&
            window !== voice.audioWindow &&
            windows.profileFor(window.webContents) === voice.profileId
          )
            window.webContents.send("catamorphic:voice-levels", {
              at: event.at,
              frameMs: event.frameMs,
              levels: event.levels,
            });
        return;
      case "learned":
        voice.applied.voiceprint = event.voiceprint;
        prefs(voice.profileId).save({ voiceprint: event.voiceprint });
        send(voice, { type: "speak", id: "learned", text: LEARNED_REPLY });
        update(voice, { learning: false });
        return;
      case "ignored":
      case "barge-in":
      case "ready":
        break;
    }
    update(voice);
  };

  /**
   * Learning the voice print: a spoken prompt, then the next few seconds
   * the person speaks (never the prompt itself) are their voice.
   */
  const beginLearning = (voice: ActiveVoice) => {
    send(voice, { type: "speak", id: "learn", text: LEARN_PROMPT });
    send(voice, { type: "learn" });
    update(voice, { learning: true });
  };

  const start = async (
    profileId: string,
    request: VoiceRequest,
    options: { learn?: boolean } = {},
  ) => {
    errors.delete(profileId);
    lastRequests.set(profileId, request);
    state.current?.agentRegistry.setVoiceTalking(talking);
    const worker = utilityProcess.fork(
      path.join(import.meta.dirname, "voice-worker.js"),
      [],
      { serviceName: "Work Voice" },
    );
    const voice: ActiveVoice = {
      profileId,
      worker,
      audioWindow: null,
      conversation: null,
      voiceOf: null,
      hearing: false,
      speaking: new Set(),
      busy: false,
      live: {
        phase: "preparing",
        target: targetOf(request),
        download: null,
        learning: false,
      },
      applied: appliedOf(prefs(profileId).load(), null),
      moving: Promise.resolve(),
    };
    active = voice;
    publish();
    const ready = new Promise<void>((resolve, reject) => {
      worker.on("message", (event: VoiceWorkerEvent) => {
        if (event.type === "ready") resolve();
        else if (event.type === "failed") reject(new Error(event.message));
        onWorkerEvent(voice, event);
      });
      worker.once("exit", (code) => {
        reject(new Error(`The speech worker stopped (exit ${code}).`));
        if (active === voice)
          void stop(`The speech worker stopped (exit ${code}).`);
      });
    });
    // Turning voice off mid-start kills the worker; nobody awaits then.
    ready.catch(() => {});
    // Each step can outlast a click that turns voice off again.
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
      const speech = paths
        ? { kind: "models" as const, paths, voice: voice.applied.voice }
        : { kind: "fake" as const, utterance: fake ?? "" };
      send(voice, {
        type: "start",
        speech,
        voiceprint: stored.voiceprint,
        pushToTalk: stored.voicePushToTalk,
      });
      if (fake === undefined) await ensureMicrophone();
      if (!live()) return;
      const resolved = await resolve(profileId, request);
      if (!live()) return;
      await ready;
      // The microphone opens once the models can hear it.
      const window = await openAudioWindow(worker, stored.voiceMicrophone);
      if (!live()) {
        window.destroy();
        return;
      }
      voice.audioWindow = window;
      // Push-to-talk keys held while voice started: talking starts now.
      if (holding === profileId) send(voice, { type: "hold", held: true });
      await connect(voice, request, resolved);
      if (options.learn) beginLearning(voice);
    } catch (cause) {
      if (live())
        await stop(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /** A live voice moves to another chat: the models stay, speech stops. */
  const retarget = async (voice: ActiveVoice, request: VoiceRequest) => {
    lastRequests.set(voice.profileId, request);
    send(voice, { type: "stop-speaking" });
    voice.conversation?.stop();
    voice.conversation = null;
    voice.busy = false;
    // The microphone clicked lights at once; a failure is its to show.
    update(voice, { target: targetOf(request) });
    try {
      const resolved = await resolve(voice.profileId, request);
      if (active !== voice) return;
      await connect(voice, request, resolved);
    } catch (cause) {
      if (active === voice)
        await stop(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // While voice is off, a session the assistant started can still report
  // back: the assistant's chat wakes, answers, and the person sees it like
  // any chat's reply. The microphone shows that there is news to hear.
  const checkNews = async () => {
    const profiles = new Set(
      BrowserWindow.getAllWindows()
        .filter(
          (window) => !window.isDestroyed() && window !== active?.audioWindow,
        )
        .map((window) => windows.profileFor(window.webContents)),
    );
    let changed = false;
    for (const profileId of profiles) {
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
      const shown = BrowserWindow.getAllWindows().some(
        (candidate) =>
          !candidate.isDestroyed() &&
          candidate !== active?.audioWindow &&
          candidate !== window &&
          candidate.isVisible(),
      );
      if (!shown && active && window !== active.audioWindow) void stop();
    };
    window.on("close", stopUnlessShown);
    window.once("closed", stopUnlessShown);
  };
  app.on("browser-window-created", onWindowCreated);

  /**
   * A request from a microphone: a chat's, or the dock's for the
   * assistant. The assistant's own chat, from its composer, is the
   * assistant.
   */
  const requestOf = (
    profileId: string,
    input: { projectId?: string; sessionId?: string },
  ): VoiceRequest | null => {
    if (!input?.projectId) return null;
    if (
      !input.sessionId ||
      input.sessionId === prefs(profileId).load().assistantSession?.sessionId
    )
      return { kind: "assistant", projectId: input.projectId };
    return {
      kind: "chat",
      projectId: input.projectId,
      sessionId: input.sessionId,
    };
  };

  ipcMain.handle("catamorphic:voice-get-status", (event) =>
    statusFor(windows.profileFor(event.sender)),
  );
  // Resolves at once: preparing can take a first download, and the status
  // events carry the rest. The same microphone again turns voice off;
  // another one moves voice to its chat.
  ipcMain.handle(
    "catamorphic:voice-toggle",
    async (event, input: { projectId?: string; sessionId?: string }) => {
      const profileId = windows.profileFor(event.sender);
      const request = requestOf(profileId, input);
      if (!request) {
        errors.set(profileId, {
          message: "Open a project to talk to Work.",
          target: null,
        });
        publish();
        return;
      }
      const voice = active;
      if (voice?.profileId === profileId && voice.conversation) {
        if (sameVoiceTarget(voice.live.target, targetOf(request))) await stop();
        else void retarget(voice, request);
        return;
      }
      // A second click on a starting microphone stops it; another one's
      // starts over there.
      const starting =
        voice?.profileId === profileId &&
        sameVoiceTarget(voice.live.target, targetOf(request));
      await stop();
      if (!starting) void start(profileId, request);
    },
  );
  // Learning starts voice when it is off: it needs the microphone.
  ipcMain.handle(
    "catamorphic:voice-learn",
    async (event, input: { projectId?: string; sessionId?: string }) => {
      const profileId = windows.profileFor(event.sender);
      const voice = active;
      if (voice?.profileId === profileId && voice.conversation) {
        beginLearning(voice);
        return;
      }
      if (voice?.profileId === profileId) return;
      const request = requestOf(profileId, input);
      if (!request) {
        errors.set(profileId, {
          message: "Open a project to talk to Work.",
          target: null,
        });
        publish();
        return;
      }
      await stop();
      void start(profileId, request, { learn: true });
    },
  );
  // Settings live in the profile's prefs, which windows read themselves:
  // a live voice follows them.
  let disposed = false;
  profileConfig.onPrefsChanged((profileId, stored) => {
    if (disposed) return;
    pushToTalkKeys.delete(profileId);
    const voice = active;
    if (voice?.profileId === profileId)
      void follow(voice, stored).catch((cause: unknown) =>
        console.warn("[voice] applying a setting failed:", cause),
      );
  });
  profileConfig.onKeybindingsChanged((profileId) =>
    pushToTalkKeys.delete(profileId),
  );

  // Push to talk: down talks, starting voice where it last talked when it
  // is off; up hands what was said over.
  const stopListening = listenForPushToTalk({
    // Read on every key press of every page: kept until they change.
    keysFor: (contents) => {
      const profileId = windows.profileFor(contents);
      if (!pushToTalkKeys.has(profileId))
        pushToTalkKeys.set(
          profileId,
          prefs(profileId).load().voicePushToTalk
            ? (profileConfig.forProfile(profileId).keybindings.load()[
                "push-to-talk"
              ] ?? null)
            : null,
        );
      const binding = pushToTalkKeys.get(profileId);
      return binding ? { profileId, binding } : null;
    },
    down: (profileId) => {
      holding = profileId;
      if (active?.profileId === profileId) {
        send(active, { type: "hold", held: true });
        return;
      }
      const stored = prefs(profileId).load();
      const projectId =
        stored.assistantSession?.projectId ?? stored.lastProjectId;
      const request =
        lastRequests.get(profileId) ??
        (projectId ? { kind: "assistant" as const, projectId } : null);
      if (!request) {
        errors.set(profileId, {
          message: "Open a project to talk to Work.",
          target: null,
        });
        publish();
        return;
      }
      void stop().then(() => start(profileId, request));
    },
    up: () => {
      if (holding !== null && active?.profileId === holding)
        send(active, { type: "hold", held: false });
      holding = null;
    },
  });

  // A reset closes the assistant's chat; the next start makes another.
  ipcMain.handle("catamorphic:voice-reset", async (event) => {
    const profileId = windows.profileFor(event.sender);
    if (active?.profileId === profileId && active.live.target?.kind !== "chat")
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
      app.off("browser-window-created", onWindowCreated);
      stopListening();
      for (const channel of [
        "catamorphic:voice-get-status",
        "catamorphic:voice-toggle",
        "catamorphic:voice-reset",
        "catamorphic:voice-learn",
      ])
        ipcMain.removeHandler(channel);
      clearInterval(newsTimer);
      await stop();
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

/**
 * The audio page: a hidden window that holds the microphone (with echo
 * cancellation) and plays the agent's voice. Its port goes straight to the
 * speech worker, so audio never passes through the main process.
 */
async function openAudioWindow(
  worker: UtilityProcess,
  microphone: string | null,
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
  const { port1, port2 } = new MessageChannelMain();
  worker.postMessage({ type: "audio" } satisfies VoiceWorkerCommand, [port1]);
  window.webContents.postMessage(VOICE_PORT_MESSAGE, microphone, [port2]);
  return window;
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
