import { Mic } from "lucide-react";
import {
  type MouseEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { AppPrefs } from "../../shared/app-prefs.js";
import {
  agentVoice,
  parseAssistantAgentId,
  rosterAgentId,
  VOICE_BARS,
  VOICE_OFF,
  VOICES,
  type VoiceId,
  type VoiceLevels,
  type VoiceSessionRef,
  type VoiceStatus,
} from "../../shared/voice.js";
import { type AgentInfo, desktopApi } from "../lib/desktop-api.js";
import { formatBinding, useKeybindings } from "../lib/keybindings";
import { useAppPreferences } from "../lib/use-app-preferences.js";
import { ShortcutHint } from "./shortcut-hint.js";
import {
  type ContextMenuEntry,
  MenuPortal,
  useMenuDismiss,
} from "./sidebar-item-row.js";

type Microphone = { id: string; label: string };

/**
 * The microphones this machine has, read once for every microphone and
 * kept current as devices come and go, while anything shows them.
 */
const microphoneList = (() => {
  let list: Microphone[] = [];
  const listeners = new Set<() => void>();
  let stop: (() => void) | undefined;
  const read = () =>
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((all) => {
        // "default" and "communications" are Chromium's aliases of real
        // devices; the menu's first entry already follows the system.
        list = all
          .filter(
            (device) =>
              device.kind === "audioinput" &&
              device.deviceId !== "default" &&
              device.deviceId !== "communications",
          )
          .map((device, index) => ({
            id: device.deviceId,
            label: device.label || `Microphone ${index + 1}`,
          }));
        for (const listener of listeners) listener();
      })
      .catch(() => {});
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      const devices = navigator.mediaDevices;
      if (!stop && devices) {
        read();
        devices.addEventListener("devicechange", read);
        stop = () => devices.removeEventListener("devicechange", read);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stop?.();
          stop = undefined;
        }
      };
    },
    get: () => list,
  };
})();

export function useMicrophones(): Microphone[] {
  return useSyncExternalStore(microphoneList.subscribe, microphoneList.get);
}

/** Voice's state for this window's profile, kept live. */
export function useVoiceStatus(): VoiceStatus {
  const [status, setStatus] = useState<VoiceStatus>(VOICE_OFF);
  useEffect(() => {
    let mounted = true;
    void desktopApi.voiceStatus().then((value) => {
      if (mounted) setStatus(value);
    });
    const unsubscribe = desktopApi.onVoiceStatus(setStatus);
    // Another profile in this window: its voice, not the last one's.
    const refetch = () =>
      void desktopApi.voiceStatus().then((value) => {
        if (mounted) setStatus(value);
      });
    window.addEventListener("catamorphic:profile-refetch", refetch);
    return () => {
      mounted = false;
      unsubscribe();
      window.removeEventListener("catamorphic:profile-refetch", refetch);
    };
  }, []);
  return status;
}

/** The profile's agents, kept current: the assistant can be any of them. */
export function useProfileAgents(enabled = true): AgentInfo[] {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let mounted = true;
    void desktopApi.agentsList().then((data) => {
      if (mounted) setAgents(data.agents);
    });
    const unsubscribe = desktopApi.onAgentsChanged((data) =>
      setAgents(data.agents),
    );
    // Another profile in this window: its agents.
    const refetch = () =>
      void desktopApi.agentsList().then((data) => {
        if (mounted) setAgents(data.agents);
      });
    window.addEventListener("catamorphic:profile-refetch", refetch);
    return () => {
      mounted = false;
      unsubscribe();
      window.removeEventListener("catamorphic:profile-refetch", refetch);
    };
  }, [enabled]);
  return agents;
}

/**
 * The assistant the person chose, while it is one of their agents; null
 * is Work's built-in assistant.
 */
export function chosenAssistant(
  prefs: Pick<AppPrefs, "voiceAssistant">,
  agents: readonly AgentInfo[],
): AgentInfo | null {
  return agents.find((agent) => agent.id === prefs.voiceAssistant) ?? null;
}

/**
 * Whose voice a chat's agent speaks in: a roster agent's own key, or null
 * (the default voice) for Work's built-in assistant.
 */
export function voiceKeyOf(agentId: string | null): string | null {
  if (!agentId) return null;
  const assistant = parseAssistantAgentId(agentId);
  return assistant?.builtIn ? null : rosterAgentId(agentId);
}

/** The prefs that give an agent its voice, or the default for a null key. */
export function voicePatch(
  prefs: Pick<AppPrefs, "agentVoices">,
  key: string | null,
  voice: VoiceId,
): Partial<AppPrefs> {
  return key
    ? { agentVoices: { ...prefs.agentVoices, [key]: voice } }
    : { voiceId: voice };
}

function hint({
  status,
  phase,
  error,
  starting,
  pushToTalk,
  pushToTalkKeys,
  name,
}: {
  status: VoiceStatus;
  /** This microphone's phase: off while voice talks elsewhere. */
  phase: VoiceStatus["phase"];
  /** Why voice stopped here, when it stopped on this microphone. */
  error: string | null;
  starting: boolean;
  pushToTalk: boolean;
  pushToTalkKeys: string;
  /** Who this microphone talks to. */
  name: string;
}): string {
  if (starting) return "Starting voice";
  if (phase === "off") return error ?? `Talk to ${name}`;
  if (status.learning) return "Learning your voice. Keep talking";
  const holdKeys = pushToTalk && pushToTalkKeys;
  switch (phase) {
    case "preparing": {
      const download = status.download;
      if (!download || download.totalBytes === 0) return "Starting voice";
      // Downloaded, the models are unpacked and put in place.
      if (download.receivedBytes >= download.totalBytes)
        return "Setting up speech";
      return `Downloading speech, ${Math.floor(
        (100 * download.receivedBytes) / download.totalBytes,
      )}%`;
    }
    case "listening":
      return holdKeys
        ? `Hold ${pushToTalkKeys} to talk. Click to stop`
        : "Listening. Click to stop";
    case "hearing":
      return "Hearing you";
    case "thinking":
      return "Working on it";
    case "speaking":
      return holdKeys
        ? `Speaking. Hold ${pushToTalkKeys} to interrupt`
        : "Speaking. Talk to interrupt";
  }
}

/** One pass of the working wave across the dots. */
const WAVE_MS = 1100;
/** How quickly the bars move between the working wave and the voice. */
const CROSSFADE_MS = 120;
/** How quickly a bar rises to a louder level, and falls back. */
const RISE_MS = 35;
const FALL_MS = 110;

/**
 * The agent working, then its voice as it is heard. From when the person
 * has been heard until the agent's first sentence plays, the bars are dots
 * a small wave passes over. Once a sentence is heard there is a bar per
 * band of speech, following the levels the audio page measured for each
 * sentence it scheduled, drawn here at the screen's rate against the time
 * each is heard: a bar rises quickly and falls back slowly, into dots
 * again when the agent goes back to work.
 */
function VoiceBars({ shown }: { shown: boolean }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    if (!shown) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const scheduled: VoiceLevels[] = [];
    const unsubscribe = desktopApi.onVoiceLevels((levels) =>
      scheduled.push(levels),
    );
    const drawn = Array.from({ length: VOICE_BARS }, () => 0);
    // 0 while the agent works, 1 while it is heard, eased in between.
    let heard = 0;
    let last = performance.now();
    let frame = 0;
    const ease = (from: number, to: number, ms: number, dt: number) =>
      from + (to - from) * (1 - Math.exp(-dt / ms));
    const draw = (time: number) => {
      const dt = Math.min(100, time - last);
      last = time;
      const now = Date.now();
      const ended = (clip: VoiceLevels) =>
        clip.at + (clip.levels.length / VOICE_BARS) * clip.frameMs <= now;
      while (scheduled[0] && ended(scheduled[0])) scheduled.shift();
      const clip = scheduled[0] && scheduled[0].at <= now ? scheduled[0] : null;
      const offset = clip
        ? Math.floor((now - clip.at) / clip.frameMs) * VOICE_BARS
        : 0;
      heard = ease(heard, clip ? 1 : 0, CROSSFADE_MS, dt);
      for (let bar = 0; bar < VOICE_BARS; bar++) {
        const wave = Math.max(
          0,
          Math.sin(2 * Math.PI * (now / WAVE_MS - bar * 0.16)),
        );
        const voice = clip ? (clip.levels[offset + bar] ?? 0) : 0;
        const target = 0.3 * wave ** 2 * (1 - heard) + voice * heard;
        const from = drawn[bar] ?? 0;
        const level = ease(from, target, target > from ? RISE_MS : FALL_MS, dt);
        drawn[bar] = level;
        bars.current[bar]?.style.setProperty("--level", level.toFixed(3));
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
    };
  }, [shown]);
  return (
    <span
      aria-hidden="true"
      className="voice-icon voice-bars"
      data-shown={shown}
    >
      {Array.from({ length: VOICE_BARS }, (_, bar) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed row of bars
          key={bar}
          ref={(element) => {
            bars.current[bar] = element;
          }}
        />
      ))}
    </span>
  );
}

const RING_RADIUS = 17;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/**
 * A microphone (ADR 0216): the dock's talks to the assistant, a composer's
 * to its chat's agent. A click starts voice there (making the assistant's
 * chat the first time, or a new chat's session); an arc turns around it
 * until it is really listening, then it lights up. Another click stops
 * it, and another microphone's click moves voice to that one. The dock's
 * shows news that came in while voice was off as a dot, heard first on the
 * next start. The right-click menu holds the settings that matter there:
 * the assistant and the voice, the microphone, push to talk, the person's
 * own voice, and where microphones show.
 */
export function VoiceButton({
  projectId,
  chat,
  nativeMenus = false,
  onOpenChat,
  onCreateAssistant,
}: {
  projectId: string | undefined;
  /** A composer's microphone: its chat. Absent: the dock's, the assistant's. */
  chat?: {
    sessionId: string | null;
    agentId: string | null;
    agentName: string | null;
    /** The chat's session, made now when it has none yet. */
    ensureSession: () => Promise<string | null>;
  };
  /** The detached dock window draws native menus (ADR 0121). */
  nativeMenus?: boolean;
  /** Opens the assistant's chat. */
  onOpenChat?: (session: VoiceSessionRef) => void;
  /** Adds an agent and makes it the assistant. */
  onCreateAssistant?: () => void;
}) {
  const status = useVoiceStatus();
  // Its own changes show at once through `update`; others' as they land.
  const { prefs, loaded, update } = useAppPreferences();
  const agents = useProfileAgents(!chat);
  const bindings = useKeybindings();
  const toggleKeys = chat ? "" : formatBinding(bindings["toggle-voice"]);
  const pushToTalkKeys = formatBinding(bindings["push-to-talk"]);
  // Voice talks to one chat at a time: this microphone shows it only while
  // that is its own. An error with no target is the dock's to show.
  const target = status.target;
  // The assistant's own chat, from its composer, talks to the assistant.
  const assistantChat =
    !!chat?.sessionId && chat.sessionId === prefs.assistantSession?.sessionId;
  const mine =
    chat && !assistantChat
      ? target?.kind === "chat" && target.sessionId === chat.sessionId
      : target?.kind === "assistant" || (!chat && target === null);
  const phase = mine ? status.phase : "off";
  const error = mine && phase === "off" ? status.error : null;
  // A click shows "starting" at once, until the main process has answered:
  // by then the status says where voice is.
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    if (phase !== "off" || error) setStarting(false);
  }, [phase, error]);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const on = phase !== "off";
  const loading = starting || phase === "preparing";
  const lit = on && !loading;
  const download = status.download;
  // The ring fills while the models download, then turns while they are
  // unpacked and loaded: a full ring that stood still would look stuck.
  const progress =
    phase === "preparing" &&
    download &&
    download.totalBytes > 0 &&
    download.receivedBytes < download.totalBytes
      ? download.receivedBytes / download.totalBytes
      : null;
  const pending = !chat && status.pending && !on;
  const assistant = chosenAssistant(prefs, agents);
  const voiceKey = chat ? voiceKeyOf(chat.agentId) : (assistant?.id ?? null);
  const voice = agentVoice(prefs, voiceKey);
  const name =
    chat && !assistantChat
      ? (chat.agentName ?? "this agent")
      : (assistant?.name ?? "Work");
  const microphones = useMicrophones();
  // A chosen microphone that is unplugged shows until it comes back;
  // listening falls back to the system's meanwhile.
  const chosenGone =
    prefs.voiceMicrophone !== null &&
    !microphones.some((microphone) => microphone.id === prefs.voiceMicrophone);
  const session = prefs.assistantSession;
  const entries: ContextMenuEntry[] = [
    ...(!chat && session
      ? [{ label: "Open assistant chat", action: "open" }]
      : []),
    ...(chat
      ? []
      : [
          {
            label: "Assistant",
            action: "assistants",
            detail: assistant?.name ?? "Built-in",
            submenu: [
              {
                label: "Built-in assistant",
                detail: "Your default agent",
                action: "assistant:",
                checked: assistant === null,
              },
              ...agents.map((agent) => ({
                label: agent.name,
                action: `assistant:${agent.id}`,
                checked: assistant?.id === agent.id,
              })),
              ...(onCreateAssistant
                ? [{ label: "Create agent…", action: "create-assistant" }]
                : []),
            ],
          },
        ]),
    {
      label: "Voice",
      action: "voices",
      detail: VOICES.find((candidate) => candidate.id === voice)?.name,
      submenu: VOICES.map((candidate) => ({
        label: candidate.name,
        detail: candidate.description,
        action: `voice:${candidate.id}`,
        checked: voice === candidate.id,
      })),
    },
    {
      label: "Microphone",
      action: "microphones",
      submenu: [
        {
          label: "System default",
          action: "microphone:",
          checked: prefs.voiceMicrophone === null,
        },
        ...microphones.map((microphone) => ({
          label: microphone.label,
          action: `microphone:${microphone.id}`,
          checked: prefs.voiceMicrophone === microphone.id,
        })),
        ...(chosenGone
          ? [
              {
                label: "Chosen microphone",
                detail: "Not connected",
                action: `microphone:${prefs.voiceMicrophone}`,
                checked: true,
              },
            ]
          : []),
      ],
    },
    {
      label: "Push to talk",
      action: "push-to-talk",
      checked: prefs.voicePushToTalk,
      setting: true,
      ...(pushToTalkKeys ? { detail: pushToTalkKeys } : {}),
    },
    // Background voices (ADR 0216): once voice knows the person's voice,
    // anyone else is ignored.
    {
      label: prefs.voiceprint ? "Relearn my voice" : "Learn my voice",
      action: "learn",
      ...(status.learning ? { disabledReason: "Learning your voice now" } : {}),
    },
    ...(prefs.voiceprint
      ? [{ label: "Forget my voice", action: "forget" }]
      : []),
    chat
      ? {
          label: "Show voice in chats",
          action: "in-chats",
          checked: prefs.voiceInChats,
          setting: true,
        }
      : {
          label: "Show voice in dock",
          action: "in-dock",
          checked: prefs.voiceInDock,
          setting: true,
        },
    ...(chat
      ? []
      : [
          {
            label: "Reset assistant chat",
            action: "reset",
            danger: true,
            ...(session || on
              ? {}
              : { disabledReason: "There is no assistant chat yet" }),
          },
        ]),
  ];
  /** Where this microphone talks: its chat (made now if new), or the dock's project. */
  const request = async (): Promise<{
    projectId?: string;
    sessionId?: string;
  } | null> => {
    if (!chat) return { projectId };
    const sessionId = chat.sessionId ?? (await chat.ensureSession());
    return sessionId ? { projectId, sessionId } : null;
  };
  /** Voice here: started, moved, stopped or learning, then settled. */
  const send = (
    call: (input: { projectId?: string; sessionId?: string }) => Promise<void>,
  ) => {
    if (!on) setStarting(true);
    void request()
      .then((input) => (input ? call(input) : undefined))
      .catch((cause: unknown) =>
        console.warn("[voice] the microphone's request failed:", cause),
      )
      .finally(() => setStarting(false));
  };
  const pick = (action: string | null) => {
    if (!action) return;
    if (action === "open" && session) onOpenChat?.(session);
    if (action === "reset") void desktopApi.voiceReset();
    if (action === "create-assistant") onCreateAssistant?.();
    if (action.startsWith("assistant:"))
      void update({
        voiceAssistant: action.slice("assistant:".length) || null,
      });
    if (action === "learn") send(desktopApi.voiceLearn);
    if (action === "forget") void update({ voiceprint: null });
    if (action === "push-to-talk")
      void update({ voicePushToTalk: !prefs.voicePushToTalk });
    if (action === "in-dock") void update({ voiceInDock: !prefs.voiceInDock });
    if (action === "in-chats")
      void update({ voiceInChats: !prefs.voiceInChats });
    const picked = VOICES.find(
      (candidate) => action === `voice:${candidate.id}`,
    );
    if (picked) void update(voicePatch(prefs, voiceKey, picked.id));
    if (action.startsWith("microphone:"))
      void update({
        voiceMicrophone: action.slice("microphone:".length) || null,
      });
  };
  const toggle = () => send(desktopApi.voiceToggle);
  const openMenu = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (nativeMenus) {
      void desktopApi
        .dockMenu(entries.filter((entry) => !entry.disabledReason))
        .then(pick);
      return;
    }
    setMenuAt({ x: event.clientX, y: event.clientY });
    setMenuOpen(true);
  };
  useMenuDismiss({ open: menuOpen, close: () => setMenuOpen(false) });
  // Out of chats, a composer shows its microphone only while voice talks
  // to its chat; a menu it had open goes with it.
  const hidden = !!chat && (!loaded || (!prefs.voiceInChats && !on));
  useEffect(() => {
    if (!hidden) return;
    setMenuOpen(false);
    setMenuAt(null);
  }, [hidden]);
  if (hidden) return null;
  // From the person heard to the agent heard: working, then speaking.
  const answering = phase === "thinking" || phase === "speaking";
  const badge =
    on || starting ? null : error ? "error" : pending ? "news" : null;
  const description = hint({
    status,
    phase,
    error,
    starting,
    pushToTalk: prefs.voicePushToTalk,
    pushToTalkKeys,
    name,
  });
  return (
    <>
      <ShortcutHint
        label={description}
        shortcut={toggleKeys || undefined}
        side="top"
      >
        <button
          type="button"
          onClick={toggle}
          onContextMenu={openMenu}
          aria-label={pending ? "Voice, news waiting" : "Voice"}
          aria-description={description}
          aria-pressed={on}
          aria-busy={loading}
          data-testid={chat ? "chat-voice-button" : "voice-button"}
          data-place={chat ? "composer" : "dock"}
          data-phase={starting ? "preparing" : phase}
          data-loading={loading || undefined}
          data-lit={lit || undefined}
          data-progress={progress === null ? undefined : true}
          data-pending={pending || undefined}
          className="voice-button"
        >
          <span aria-hidden="true" className="voice-ripple" />
          <svg aria-hidden="true" viewBox="0 0 38 38" className="voice-ring">
            <circle
              cx="19"
              cy="19"
              r={RING_RADIUS}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={RING_LENGTH}
              strokeDashoffset={RING_LENGTH * (1 - (progress ?? 0.28))}
              transform="rotate(-90 19 19)"
              style={{ transition: "stroke-dashoffset 200ms" }}
            />
          </svg>
          <Mic
            aria-hidden="true"
            className="voice-icon"
            data-shown={!answering}
          />
          <VoiceBars shown={answering} />
          <span
            aria-hidden="true"
            className="voice-badge"
            data-testid={badge === "error" ? "voice-error" : "voice-news"}
            data-kind={badge ?? undefined}
            data-shown={badge !== null}
          />
        </button>
      </ShortcutHint>
      {menuAt && (
        <MenuPortal
          open={menuOpen}
          position={menuAt}
          entries={entries}
          onPick={(entry) => {
            setMenuOpen(false);
            pick(entry.action);
          }}
          onExited={() => setMenuAt(null)}
        />
      )}
    </>
  );
}
