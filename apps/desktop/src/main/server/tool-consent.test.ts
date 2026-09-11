import { expect, it, vi } from "vitest";
import { askToolConsent } from "./tool-consent.js";

const request = {
  sessionId: "chat",
  server: "calendar",
  tool: "create_event",
  description: "Create tomorrow's planning meeting.",
  input: {},
};

it.each([
  ["Allow once", { decision: "allow" }],
  ["Always allow", { decision: "allow", remember: "always" }],
  ["Deny", { decision: "deny" }],
  ["maybe, explain first", { decision: "deny" }],
])("requires an explicit consent choice: %s", async (answer, expected) => {
  const askQuestion = vi.fn(async () => answer);
  expect(await askToolConsent({ askQuestion, request })).toEqual(expected);
  expect(askQuestion).toHaveBeenCalledWith(
    expect.objectContaining({
      blocking: true,
      questions: [
        expect.objectContaining({
          question: expect.stringContaining(
            "Create tomorrow's planning meeting.",
          ),
        }),
      ],
    }),
  );
});

it("does not grant access after cancellation even if the answer arrives late", async () => {
  const abort = new AbortController();
  const askQuestion = vi.fn(async () => {
    abort.abort();
    return "Always allow";
  });
  expect(
    await askToolConsent({ askQuestion, request, signal: abort.signal }),
  ).toEqual({ decision: "deny" });
});

it("offers only per-request consent for native approvals", async () => {
  const askQuestion = vi.fn(async () => "Always allow");
  expect(
    await askToolConsent({
      askQuestion,
      request: {
        ...request,
        server: "codex",
        tool: "item/commandExecution/requestApproval",
      },
    }),
  ).toEqual({ decision: "deny" });
  expect(askQuestion).toHaveBeenCalledWith(
    expect.objectContaining({
      questions: [
        expect.objectContaining({
          options: [
            expect.objectContaining({ label: "Allow once" }),
            expect.objectContaining({ label: "Deny" }),
          ],
        }),
      ],
    }),
  );
});
