import { describe, expect, it, vi } from "vitest";
import { McpError } from "../mcp-server.js";
import {
  elicitationFor,
  responseFor,
  signRequestState,
  verifyRequestState,
} from "../session-mcp.js";

/*
 * What a wait hands a client with what it asks (ADR 0345): the state is
 * the client's to echo and nothing else, and an agent's request is a form
 * its person fills in.
 */

const SECRET = "test-secret";
const state = (overrides: Record<string, unknown> = {}) =>
  signRequestState(
    {
      sub: "tenant:alice",
      tool: "session_wait",
      sessions: ["s1", "s2"],
      requests: ["r1"],
      exp: Date.now() + 60_000,
      ...overrides,
    },
    SECRET,
  );
const verify = (
  value: string,
  expected: Partial<{ sub: string; sessions: string[]; secret: string }> = {},
) =>
  verifyRequestState(value, {
    sub: "tenant:alice",
    sessions: ["s2", "s1"],
    secret: SECRET,
    ...expected,
  });

describe("request state", () => {
  it("is accepted as it was handed out, for the same member and chats", () => {
    expect(verify(state())).toMatchObject({ requests: ["r1"] });
  });

  it("is refused when changed, signed with another secret, or malformed", () => {
    const [body = "", mac = ""] = state().split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
        sub: "tenant:mallory",
      }),
    ).toString("base64url");
    for (const tampered of [
      `${forged}.${mac}`,
      `${body}.`,
      body,
      `${body}.${mac}.extra`,
      "",
    ])
      expect(() => verify(tampered)).toThrow(McpError);
    expect(() => verify(state(), { secret: "another" })).toThrow(McpError);
  });

  it("is refused for another member, other chats, or once it expired", () => {
    expect(() => verify(state(), { sub: "tenant:bob" })).toThrow(McpError);
    expect(() => verify(state(), { sessions: ["s1"] })).toThrow(McpError);
    expect(() => verify(state({ exp: Date.now() - 1 }))).toThrow(McpError);
    vi.useFakeTimers();
    try {
      const fresh = state();
      vi.advanceTimersByTime(61_000);
      expect(() => verify(fresh)).toThrow("Invalid or expired requestState");
    } finally {
      vi.useRealTimers();
    }
  });
});

const request = {
  requestId: "r1",
  title: "Question",
  description: null,
  blocking: true,
  turnId: "t1",
  questions: null,
  approval: null,
  elicitation: null,
  expiresAt: null,
};

describe("an agent's request as a form", () => {
  it("asks each question with its options, and reads the answers back", () => {
    const question = {
      ...request,
      kind: "question" as const,
      questions: [
        {
          question: "Which branch?",
          header: "Branch",
          multiSelect: false,
          options: [
            { label: "main", description: "" },
            { label: "release", description: "" },
          ],
        },
        {
          question: "Which checks?",
          header: "Checks",
          multiSelect: true,
          options: [
            { label: "lint", description: "" },
            { label: "test", description: "" },
          ],
        },
        {
          question: "Anything else?",
          header: "",
          multiSelect: false,
          options: [],
        },
      ],
    };
    expect(elicitationFor(question, { mayApprove: false })).toEqual({
      method: "elicitation/create",
      params: {
        mode: "form",
        message: "Question",
        requestedSchema: {
          type: "object",
          properties: {
            answer1: {
              type: "string",
              title: "Branch",
              description: "Which branch?",
              enum: ["main", "release"],
            },
            answer2: {
              type: "array",
              title: "Checks",
              description: "Which checks?",
              minItems: 1,
              items: { type: "string", enum: ["lint", "test"] },
            },
            answer3: {
              type: "string",
              title: "Question 3",
              description: "Anything else?",
            },
          },
          required: ["answer1", "answer2", "answer3"],
        },
      },
    });
    expect(
      responseFor(question, {
        action: "accept",
        content: { answer1: "main", answer2: ["lint", "test"], answer3: "No" },
      }),
    ).toEqual({ kind: "question", answers: ["main", "lint, test", "No"] });
    // A person who declined, or left one out, answered nothing.
    expect(responseFor(question, { action: "decline" })).toBeUndefined();
    expect(
      responseFor(question, { action: "accept", content: { answer1: "main" } }),
    ).toBeUndefined();
  });

  it("offers an approval only to a client that may approve", () => {
    const approval = {
      ...request,
      kind: "approval" as const,
      title: "Create an issue",
      approval: { action: "github.create_issue" },
    };
    expect(elicitationFor(approval, { mayApprove: false })).toBeUndefined();
    expect(
      elicitationFor(approval, { mayApprove: true })?.params,
    ).toMatchObject({
      mode: "form",
      requestedSchema: {
        properties: { decision: { enum: ["approve", "deny", "always"] } },
        required: ["decision"],
      },
    });
    const decide = (decision: string) =>
      responseFor(approval, { action: "accept", content: { decision } });
    expect(decide("approve")).toEqual({
      kind: "approval",
      decision: "approved",
    });
    expect(decide("deny")).toEqual({ kind: "approval", decision: "denied" });
    expect(decide("always")).toEqual({
      kind: "approval",
      decision: "approved",
      remember: "always",
    });
    expect(decide("maybe")).toBeUndefined();
    expect(responseFor(approval, { action: "cancel" })).toBeUndefined();
  });

  it("passes a connector's own form through, and its person's refusal", () => {
    const elicitation = {
      ...request,
      kind: "elicitation" as const,
      elicitation: {
        server: "github",
        message: "Your username",
        schema: { type: "object", properties: { name: { type: "string" } } },
      },
    };
    expect(elicitationFor(elicitation, { mayApprove: false })).toMatchObject({
      params: {
        message: "Your username",
        requestedSchema: { properties: { name: { type: "string" } } },
      },
    });
    expect(
      responseFor(elicitation, { action: "accept", content: { name: "o" } }),
    ).toEqual({
      kind: "elicitation",
      action: "accept",
      content: { name: "o" },
    });
    expect(responseFor(elicitation, { action: "decline" })).toEqual({
      kind: "elicitation",
      action: "decline",
    });
    // Nothing to fill in: it is the chat's person who opens a link.
    expect(
      elicitationFor(
        {
          ...elicitation,
          elicitation: {
            server: "github",
            message: "Sign in",
            url: "https://x",
          },
        },
        { mayApprove: true },
      ),
    ).toBeUndefined();
  });
});
