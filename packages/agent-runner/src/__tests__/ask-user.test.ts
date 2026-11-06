import type { RuntimeRequestResponse } from "@catamorphic/agent-protocol";
import {
  RequestClosedError,
  type RequestDraft,
} from "@catamorphic/agent-protocol/runner";
import { describe, expect, it } from "vitest";
import { askUser } from "../ask-user.js";

/* Work's ask_user tool, answered in the runner for every harness (ADR 0195). */

const question = { question: "Which theme?", header: "Theme" };

function fakeHost(answer: () => Promise<RuntimeRequestResponse>) {
  const opened: Array<{ key: string; request: RequestDraft }> = [];
  return {
    opened,
    request: (key: string, request: RequestDraft) => {
      opened.push({ key, request });
      return answer();
    },
  };
}

describe("ask_user", () => {
  it("waits for a blocking question's answer", async () => {
    const host = fakeHost(async () => ({
      kind: "question",
      answers: ["Dark"],
    }));
    const result = await askUser(host, {
      input: { questions: [question] },
      itemKey: "call-1",
    });
    expect(host.opened[0]).toMatchObject({
      key: "ask:call-1",
      request: { kind: "question", blocking: true, title: "Which theme?" },
    });
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Which theme?\nAnswer: Dark",
    });
  });

  it("opens a non-blocking question and returns at once", async () => {
    const host = fakeHost(() => new Promise(() => {}));
    const result = await askUser(host, {
      input: { blocking: false, questions: [question] },
    });
    expect(host.opened[0]?.request.blocking).toBe(false);
    expect(JSON.stringify(result.content)).toContain("arrives as a message");
  });

  it("says when the question closed unanswered, and refuses bad input", async () => {
    const closed = fakeHost(() =>
      Promise.reject(new RequestClosedError("The person replied in the chat.")),
    );
    expect(
      (await askUser(closed, { input: { questions: [question] } })).content[0],
    ).toMatchObject({ text: expect.stringContaining("replied in the chat") });
    const invalid = await askUser(closed, { input: { questions: [] } });
    expect(invalid.isError).toBe(true);
  });
});
