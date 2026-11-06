import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  JsonValue,
  RuntimeRequestResponse,
} from "@catamorphic/agent-protocol";
import type {
  AttemptHost,
  AttemptStart,
  HarnessEvent,
  HostToolResult,
  RequestDraft,
} from "@catamorphic/agent-protocol/runner";
import { STOPPED_WAITING_NOTE } from "@catamorphic/sandbox";
import { afterEach, beforeEach, expect, it } from "vitest";
import { E2eFakeAdapter } from "./e2e-fakes.js";

let workingDirectory: string;
beforeEach(async () => {
  workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "e2e-fake-"));
});
afterEach(async () => {
  await fs.rm(workingDirectory, { recursive: true, force: true });
});

/** A host that records events and answers requests with `answer`. */
function hostFor(input: {
  answer?: (request: RequestDraft) => RuntimeRequestResponse;
  saved?: JsonValue[];
  callTool?: AttemptHost["callTool"];
}) {
  const events: HarnessEvent[] = [];
  const requests: RequestDraft[] = [];
  const appended: JsonValue[] = [];
  const host = {
    emit: (event: HarnessEvent) => events.push(event),
    callTool:
      input.callTool ??
      (async () => ({ content: [{ type: "text", text: "{}" }] })),
    authorize: async () => ({ allowed: true }),
    request: async (_key: string, request: RequestDraft) => {
      requests.push(request);
      if (!input.answer) return new Promise<RuntimeRequestResponse>(() => {});
      return input.answer(request);
    },
    nativeState: {
      append: async ({ entries }: { entries: JsonValue[] }) => {
        appended.push(...entries);
      },
      load: async () => input.saved ?? null,
      subpaths: async () => [],
    },
    signal: new AbortController().signal,
  } as unknown as AttemptHost;
  return { host, events, requests, appended };
}

function attemptFor(text: string, resumed = false): AttemptStart {
  return {
    sessionId: "session",
    projectId: "project",
    workingDirectory,
    thread: resumed
      ? {
          mode: "resume",
          providerThreadId: "thread",
          nativeRef: { id: "thread", strength: "strong" },
        }
      : { mode: "fresh", providerThreadId: "thread" },
    input: { itemId: "input", text, attachments: [] },
    hostTools: [],
  } as unknown as AttemptStart;
}

function replyOf(events: HarnessEvent[]): string {
  return events
    .flatMap((event) =>
      event.type === "item.started" && event.item.kind === "assistant_message"
        ? [event.item.text]
        : event.type === "item.delta"
          ? [event.text]
          : [],
    )
    .join("");
}

it("echoes a message with a title and completes the turn", async () => {
  const { host, events } = hostFor({});
  await new E2eFakeAdapter().start(attemptFor("hello"), host).finished;
  expect(events).toContainEqual({ type: "title", text: "Quick chat" });
  expect(replyOf(events)).toBe("You said: hello");
  expect(events.at(-1)).toEqual({
    type: "turn.completed",
    status: "completed",
  });
});

it("reads discovery JSON when a steer appends the host's waiting note", async () => {
  const { host, events } = hostFor({
    callTool: async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            items: [{ name: "workspace.list_project_sessions" }],
          }),
        },
        { type: "text", text: STOPPED_WAITING_NOTE },
      ],
    }),
  });
  await new E2eFakeAdapter().start(
    attemptFor("Which session capabilities can you find?"),
    host,
  ).finished;
  expect(replyOf(events)).toBe("Capabilities: workspace.list_project_sessions");
  expect(events.at(-1)).toEqual({
    type: "turn.completed",
    status: "completed",
  });
});

it("still parses JSON joined across text blocks", async () => {
  const { host, events } = hostFor({
    callTool: async () => ({
      content: [
        { type: "text", text: '{"items":[' },
        { type: "text", text: '{"name":"workspace.list_project_sessions"}]}' },
      ],
    }),
  });
  await new E2eFakeAdapter().start(
    attemptFor("Which session capabilities can you find?"),
    host,
  ).finished;
  expect(replyOf(events)).toBe("Capabilities: workspace.list_project_sessions");
});

it("prefers joined JSON even when its first block is valid JSON too", async () => {
  const { host, events } = hostFor({
    callTool: async () => ({
      content: [
        { type: "text", text: "1" },
        { type: "text", text: "2" },
      ],
    }),
  });
  const attempt = {
    ...attemptFor("Close my questions"),
    hostTools: [
      {
        name: "close_questions",
        description: "Close questions",
        inputSchema: {},
      },
    ],
  };
  await new E2eFakeAdapter().start(attempt, host).finished;
  expect(replyOf(events)).toBe("Questions: 12");
});

it("keeps waiting notes on ordinary plain-text tool replies", async () => {
  const { host, events } = hostFor({
    callTool: async () => ({
      content: [
        { type: "text", text: "No open questions matched.\n" },
        { type: "text", text: STOPPED_WAITING_NOTE },
      ],
    }),
  });
  const attempt = {
    ...attemptFor("Close my questions"),
    hostTools: [
      {
        name: "close_questions",
        description: "Close questions",
        inputSchema: {},
      },
    ],
  };
  await new E2eFakeAdapter().start(attempt, host).finished;
  expect(replyOf(events)).toBe(
    `Questions: No open questions matched.\n${STOPPED_WAITING_NOTE}`,
  );
});

it("prefers structured tool data to text content", async () => {
  const result: HostToolResult = {
    structured: { items: [{ name: "structured.capability" }] },
    content: [
      { type: "text", text: '{"items":[{"name":"text.capability"}]}' },
      { type: "text", text: STOPPED_WAITING_NOTE },
    ],
  };
  const { host, events } = hostFor({ callTool: async () => result });
  await new E2eFakeAdapter().start(
    attemptFor("Which session capabilities can you find?"),
    host,
  ).finished;
  expect(replyOf(events)).toBe("Capabilities: structured.capability");
});

it("fails tool errors even when they include structured data", async () => {
  const { host, events } = hostFor({
    callTool: async () => ({
      isError: true,
      structured: { items: [{ name: "structured.capability" }] },
      content: [
        { type: "text", text: "Discovery failed.\n" },
        { type: "text", text: STOPPED_WAITING_NOTE },
      ],
    }),
  });
  await new E2eFakeAdapter().start(
    attemptFor("Which session capabilities can you find?"),
    host,
  ).finished;
  expect(replyOf(events)).toBe("");
  expect(events.at(-1)).toEqual({
    type: "turn.completed",
    status: "failed",
    error: { message: `Discovery failed.\n${STOPPED_WAITING_NOTE}` },
  });
});

it("writes a file into the chat's checkout and reports the change", async () => {
  const { host, events } = hostFor({});
  await new E2eFakeAdapter().start(attemptFor("please edit a file"), host)
    .finished;
  expect(
    await fs.readFile(path.join(workingDirectory, "HELLO.md"), "utf8"),
  ).toContain("hello from the fake agent");
  expect(
    events.some(
      (event) =>
        event.type === "item.started" &&
        event.item.kind === "file_change" &&
        event.item.path === "HELLO.md",
    ),
  ).toBe(true);
});

it("asks a question whose answer arrives as the next message", async () => {
  const first = hostFor({});
  await new E2eFakeAdapter().start(
    attemptFor("ask me some questions"),
    first.host,
  ).finished;
  expect(first.requests[0]).toMatchObject({
    kind: "question",
    blocking: false,
  });
  expect(first.appended).toEqual([{ askedQuestion: true }]);
  const second = hostFor({ saved: first.appended });
  await new E2eFakeAdapter().start(attemptFor("Orange", true), second.host)
    .finished;
  expect(replyOf(second.events)).toBe("Got it, noted: Orange");
});

it("asks for a tool approval and echoes the answer", async () => {
  const { host, events, requests } = hostFor({
    answer: () => ({
      kind: "approval",
      decision: "approved",
      remember: "always",
    }),
  });
  await new E2eFakeAdapter().start(attemptFor("permission: fake/post"), host)
    .finished;
  expect(requests[0]).toMatchObject({ kind: "approval", title: "Allow post?" });
  expect(replyOf(events)).toBe("permission decision: allow (always)");
});

it("stops a slow turn when interrupted", async () => {
  const { host, events } = hostFor({});
  const control = new E2eFakeAdapter().start(attemptFor("slowly"), host);
  await new Promise((resolve) => setTimeout(resolve, 50));
  control.interrupt();
  await control.finished;
  expect(events.at(-1)).toEqual({
    type: "turn.completed",
    status: "interrupted",
  });
});

it("fails an auth error once, with the provider's own words", async () => {
  const message = `auth error ${Math.random()}`;
  const first = hostFor({});
  await new E2eFakeAdapter().start(attemptFor(message), first.host).finished;
  expect(first.events.at(-1)).toEqual({
    type: "turn.completed",
    status: "failed",
    error: { message: "User not found." },
  });
  const retry = hostFor({});
  await new E2eFakeAdapter().start(attemptFor(message), retry.host).finished;
  expect(replyOf(retry.events)).toBe("Recovered after reconnecting.");
});
