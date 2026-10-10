import {
  isSettledTurnStatus,
  type SessionSnapshot,
} from "@catamorphic/agent-protocol";
import type { VoiceSessionRef } from "../../shared/voice.js";
import { isStopCommand, speakableText } from "./speech-text.js";

/** A message of a chat, as voice reads it. */
export interface VoiceMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Still being written. */
  writing: boolean;
}

/** A question the chat's agent asked, waiting for an answer. */
interface VoiceQuestion {
  id: string;
  prompt: string;
  options: string[];
}

/** A chat as voice needs it: what was said, and what is going on. */
export interface VoiceChat {
  messages: VoiceMessage[];
  /** A turn is queued or running. */
  busy: boolean;
  questions: VoiceQuestion[];
}

/** A chat from its session snapshot (ADR 0197's event log). */
export function voiceChatOf(snapshot: SessionSnapshot): VoiceChat {
  const messages: VoiceMessage[] = [];
  for (const item of [...snapshot.items].sort(
    (a, b) => a.position - b.position,
  )) {
    if (item.kind !== "user_message" && item.kind !== "assistant_message")
      continue;
    messages.push({
      id: item.id,
      role: item.kind === "user_message" ? "user" : "assistant",
      text: item.text,
      writing: item.status === "in_progress",
    });
  }
  const questions: VoiceQuestion[] = [];
  for (const request of snapshot.requests) {
    if (request.kind !== "question" || request.status !== "pending") continue;
    const [first] = request.questions ?? [];
    if (!first) continue;
    questions.push({
      id: request.id,
      prompt: first.question,
      options: first.options.map((option) => option.label),
    });
  }
  return {
    messages,
    busy: snapshot.turns.some(
      (turn) => turn.status !== "held" && !isSettledTurnStatus(turn.status),
    ),
    questions,
  };
}

/** A chat's session operations, bound to the desktop's identity. */
interface VoiceSessions {
  get(ref: VoiceSessionRef): Promise<VoiceChat>;
  send(ref: VoiceSessionRef, text: string): Promise<void>;
  interrupt(ref: VoiceSessionRef): Promise<void>;
}

/** The speech worker, as the conversation drives it. */
interface VoiceSpeech {
  speak(id: string, text: string): void;
  cue(): void;
  stopSpeaking(): void;
}

const BUSY_POLL_MS = 250;
const IDLE_POLL_MS = 1_000;

/**
 * One listening stretch of a chat (ADR 0215). What the person says
 * becomes the chat's next message; every reply the chat settles from then
 * on is spoken, including replies it gives later on its own, when a
 * session it started delivers its result. A reply is spoken once it is
 * finished, whole: each text segment of a turn is its own message
 * (preambles before tool calls first), so the agent is still heard before
 * its turn ends.
 *
 * With `heardThrough`, replies that came while voice was off are spoken
 * first when it starts: everything after the last reply the person heard.
 * The assistant's chat keeps that mark (a session it started reported back,
 * and it answered); any other chat's earlier replies are its history.
 *
 * The chat stays the source of truth. The person can type into it, open
 * it, or answer its questions in the dock; voice just speaks and listens.
 */
export class VoiceConversation {
  /** Assistant messages already said, or settled before listening began. */
  private readonly settled = new Set<string>();
  private readonly asked = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private busy = false;
  private heardThrough: string | null = null;

  constructor(
    readonly ref: VoiceSessionRef,
    private readonly deps: {
      sessions: VoiceSessions;
      speech: VoiceSpeech;
      /** Whether the chat has a turn queued or running. */
      onBusy: (busy: boolean) => void;
      onError: (message: string) => void;
      /** The last reply the person heard before, if any. */
      heardThrough?: string | null;
      /**
       * The person has heard the chat up to this message: a reply spoken,
       * or a message settled while listening.
       */
      onHeard?: (messageId: string) => void;
    },
  ) {}

  async start(): Promise<void> {
    const chat = await this.deps.sessions.get(this.ref);
    const unheard = new Set(
      unheardReplies(chat.messages, this.deps.heardThrough ?? null).map(
        (message) => message.id,
      ),
    );
    for (const message of chat.messages)
      if (
        message.role === "assistant" &&
        !message.writing &&
        !unheard.has(message.id)
      )
        this.settled.add(message.id);
    for (const question of chat.questions) this.asked.add(question.id);
    this.observe(chat);
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** What the person said, as the recognizer heard it. */
  async heard(text: string): Promise<void> {
    if (this.stopped) return;
    if (isStopCommand(text)) {
      this.deps.speech.stopSpeaking();
      if (this.busy) await this.deps.sessions.interrupt(this.ref);
      return;
    }
    this.deps.speech.cue();
    this.setBusy(true);
    try {
      await this.deps.sessions.send(this.ref, text);
    } catch (cause) {
      this.setBusy(false);
      this.deps.onError(
        `The chat did not take that message: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    this.schedule(0);
  }

  private schedule(delay = this.busy ? BUSY_POLL_MS : IDLE_POLL_MS): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), delay);
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    try {
      this.observe(await this.deps.sessions.get(this.ref));
    } catch (cause) {
      this.deps.onError(
        `The chat could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return;
    }
    this.schedule();
  }

  private observe(chat: VoiceChat): void {
    if (this.stopped) return;
    this.setBusy(chat.busy);
    // A reply is spoken once it is finished, all of it at once.
    for (const message of chat.messages) {
      if (
        message.role !== "assistant" ||
        message.writing ||
        this.settled.has(message.id)
      )
        continue;
      this.settled.add(message.id);
      const spoken = speakableText(message.text);
      if (spoken) this.deps.speech.speak(message.id, spoken);
    }
    // Heard through the latest message before any reply still being
    // written: everything up to it was said by the person or to them.
    const writing = chat.messages.findIndex(
      (message) => message.role === "assistant" && message.writing,
    );
    const through = (
      writing < 0 ? chat.messages : chat.messages.slice(0, writing)
    ).at(-1);
    if (through) this.markHeard(through.id);
    for (const question of chat.questions) {
      if (this.asked.has(question.id)) continue;
      this.asked.add(question.id);
      const prompt = speakableText(question.prompt);
      this.deps.speech.speak(
        question.id,
        question.options.length
          ? `${prompt} ${listed(question.options)}`
          : prompt,
      );
    }
  }

  private markHeard(messageId: string): void {
    if (this.heardThrough === messageId) return;
    this.heardThrough = messageId;
    this.deps.onHeard?.(messageId);
  }

  private setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    this.deps.onBusy(busy);
  }
}

/**
 * Settled replies after the last one the person heard, oldest first. With
 * nothing heard yet there is nothing to catch up on: the chat is new, or
 * was made before voice remembered.
 */
export function unheardReplies(
  messages: readonly VoiceMessage[],
  heardThrough: string | null,
): VoiceMessage[] {
  if (!heardThrough) return [];
  const heard = messages.findIndex((message) => message.id === heardThrough);
  if (heard < 0) return [];
  return messages
    .slice(heard + 1)
    .filter(
      (message) =>
        message.role === "assistant" &&
        !message.writing &&
        message.text.trim() !== "",
    );
}

function listed(options: string[]): string {
  if (options.length === 1) return `${options[0]}?`;
  return `${options.slice(0, -1).join(", ")}, or ${options.at(-1)}?`;
}
