import type { SessionSnapshot } from "@catamorphic/agent-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type VoiceChat,
  VoiceConversation,
  type VoiceMessage,
  voiceChatOf,
} from "./conversation.js";

const ref = { projectId: "p1", sessionId: "s1" };

function message(
  id: string,
  text: string,
  options: { writing?: boolean; role?: VoiceMessage["role"] } = {},
): VoiceMessage {
  return {
    id,
    text,
    role: options.role ?? "assistant",
    writing: options.writing ?? false,
  };
}

function detail(
  messages: VoiceMessage[],
  extra: Partial<VoiceChat> = {},
): VoiceChat {
  return { messages, busy: false, questions: [], ...extra };
}

function harness(initial: VoiceChat, heardThrough?: string) {
  let current = initial;
  const spoken: string[] = [];
  const sent: string[] = [];
  const calls: string[] = [];
  const busy: boolean[] = [];
  const heard: string[] = [];
  const conversation = new VoiceConversation(ref, {
    sessions: {
      get: async () => current,
      send: async (_ref, text) => {
        sent.push(text);
      },
      interrupt: async () => {
        calls.push("interrupt");
      },
    },
    speech: {
      speak: (_id, text) => spoken.push(text),
      cue: () => calls.push("cue"),
      stopSpeaking: () => calls.push("stop-speaking"),
    },
    onBusy: (value) => busy.push(value),
    onError: (error) => calls.push(`error:${error}`),
    heardThrough: heardThrough ?? null,
    onHeard: (id) => heard.push(id),
  });
  return {
    conversation,
    spoken,
    sent,
    calls,
    busy,
    heard,
    set: (next: VoiceChat) => {
      current = next;
    },
    poll: async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("VoiceConversation", () => {
  it("speaks replies that land after listening began, never the history", async () => {
    vi.useFakeTimers();
    const voice = harness(detail([message("old", "An earlier answer.")]));
    await voice.conversation.start();
    expect(voice.spoken).toEqual([]);
    voice.set(
      detail([
        message("old", "An earlier answer."),
        message("new", "**Done.** The tests pass."),
      ]),
    );
    await voice.poll();
    expect(voice.spoken).toEqual(["Done. The tests pass."]);
    await voice.poll();
    expect(voice.spoken).toHaveLength(1);
    voice.conversation.stop();
  });

  it("catches up first on replies that came while voice was off", async () => {
    vi.useFakeTimers();
    const voice = harness(
      detail([
        message("a", "Heard before."),
        message("u", "The docs session finished.", { role: "user" }),
        message("b", "The docs are tidy now."),
        message("c", "It also asks whether to keep the old pages."),
      ]),
      "a",
    );
    await voice.conversation.start();
    expect(voice.spoken).toEqual([
      "The docs are tidy now.",
      "It also asks whether to keep the old pages.",
    ]);
    expect(voice.heard).toEqual(["c"]);
    voice.conversation.stop();
  });

  it("keeps what was heard moving forward, never back to the person's words", async () => {
    vi.useFakeTimers();
    const voice = harness(
      detail([message("u0", "Hi.", { role: "user" }), message("a0", "Hello.")]),
      "a0",
    );
    await voice.conversation.start();
    expect(voice.heard).toEqual(["a0"]);
    voice.set(
      detail([
        message("u0", "Hi.", { role: "user" }),
        message("a0", "Hello."),
        message("u1", "Another one.", { role: "user" }),
        message("a1", "A user walks into a bar.", { writing: true }),
      ]),
    );
    await voice.poll();
    // The reply is still being written: heard up to the person's words.
    expect(voice.heard).toEqual(["a0", "u1"]);
    const settled = detail([
      message("u0", "Hi.", { role: "user" }),
      message("a0", "Hello."),
      message("u1", "Another one.", { role: "user" }),
      message("a1", "A user walks into a bar."),
    ]);
    voice.set(settled);
    await voice.poll();
    await voice.poll();
    expect(voice.heard).toEqual(["a0", "u1", "a1"]);
    voice.conversation.stop();
  });

  it("speaks a reply once it is finished, whole", async () => {
    vi.useFakeTimers();
    const voice = harness(detail([]));
    await voice.conversation.start();
    voice.set(
      detail(
        [
          message("live", "Let me check what's running. Two", {
            writing: true,
          }),
        ],
        { busy: true },
      ),
    );
    await voice.poll();
    // Nothing is said while the reply is still being written.
    expect(voice.spoken).toEqual([]);
    expect(voice.busy).toEqual([true]);
    voice.set(
      detail([message("live", "Let me check what's running. Two are.")]),
    );
    await voice.poll();
    expect(voice.spoken).toEqual(["Let me check what's running. Two are."]);
    expect(voice.busy).toEqual([true, false]);
    await voice.poll();
    expect(voice.spoken).toHaveLength(1);
    voice.conversation.stop();
  });

  it("sends what the person said with a heard-you cue", async () => {
    vi.useFakeTimers();
    const voice = harness(detail([]));
    await voice.conversation.start();
    await voice.conversation.heard("start a session to fix the build");
    expect(voice.sent).toEqual(["start a session to fix the build"]);
    expect(voice.calls).toEqual(["cue"]);
    voice.conversation.stop();
  });

  it("treats stop as a command: silence, and the turn interrupted", async () => {
    vi.useFakeTimers();
    const voice = harness(detail([], { busy: true }));
    await voice.conversation.start();
    await voice.conversation.heard("Stop.");
    expect(voice.sent).toEqual([]);
    expect(voice.calls).toEqual(["stop-speaking", "interrupt"]);
    voice.conversation.stop();
  });

  it("reads out a question the chat asks, with its options", async () => {
    vi.useFakeTimers();
    const voice = harness(detail([]));
    await voice.conversation.start();
    voice.set(
      detail([], {
        questions: [
          { id: "q1", prompt: "Which branch?", options: ["main", "release"] },
        ],
      }),
    );
    await voice.poll();
    expect(voice.spoken).toEqual(["Which branch? main, or release?"]);
    voice.conversation.stop();
  });
});

describe("voiceChatOf", () => {
  const common = {
    sessionId: "s1",
    turnId: "t1",
    attemptId: null,
    parentItemId: null,
    nativeRef: null,
    createdAt: "",
    updatedAt: "",
    startedAt: null,
    endedAt: null,
  };
  const snapshot: SessionSnapshot = {
    sequence: 9,
    session: {} as SessionSnapshot["session"],
    turns: [
      {
        id: "t1",
        sessionId: "s1",
        ordinal: 1,
        status: "running",
        inputItemId: "u",
        dispatch: "queue",
        priority: 0,
        activity: null,
        activityAt: null,
        attemptCount: 1,
        activeAttemptId: null,
        providerThreadId: null,
        retryAt: null,
        cancellationRequested: false,
        error: null,
        outcome: null,
        checkpoint: { before: null, after: null },
        continuationOf: null,
        createdAt: "",
        startedAt: null,
        completedAt: null,
        updatedAt: "",
      },
    ],
    attempts: [],
    items: [
      {
        ...common,
        id: "a",
        kind: "assistant_message",
        position: 3,
        status: "in_progress",
        text: "Let me",
        agentId: null,
      },
      {
        ...common,
        id: "u",
        kind: "user_message",
        position: 1,
        status: "completed",
        text: "Hi",
        author: { kind: "user", externalUserId: "me" },
        attachments: [],
        dispatch: "queue",
        attention: null,
        idempotencyKey: null,
        metadata: {},
      },
    ],
    requests: [],
    providerThreads: [],
    olderBefore: null,
  };

  it("reads the messages in order, what is still being written, and a running turn", () => {
    expect(voiceChatOf(snapshot)).toEqual({
      messages: [
        { id: "u", role: "user", text: "Hi", writing: false },
        { id: "a", role: "assistant", text: "Let me", writing: true },
      ],
      busy: true,
      questions: [],
    });
  });
});
