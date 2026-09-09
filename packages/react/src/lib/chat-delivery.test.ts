import { expect, it } from "vitest";
import {
  initialChatDelivery,
  chatDeliveryReducer as reduce,
} from "./chat-delivery.js";

it("settles overlapping deliveries independently and ignores duplicate completion", () => {
  const scope = {};
  const a = { id: "a", role: "user" as const, content: "A" };
  const b = { ...a, id: "b" };
  let state = reduce(initialChatDelivery(scope), {
    type: "start",
    scope,
    message: a,
  });
  state = reduce(state, { type: "start", scope, message: b });
  state = reduce(state, {
    type: "accepted",
    scope,
    id: "b",
    messageId: "saved-b",
  });
  state = reduce(state, { type: "settled", scope, id: "b", accepted: true });
  expect(state.pending).toEqual(["a"]);
  expect(
    reduce(state, { type: "settled", scope, id: "b", accepted: true }),
  ).toBe(state);
  state = reduce(state, { type: "settled", scope, id: "a", accepted: false });
  expect(state.failed).toEqual([a]);
  expect(state.pending).toEqual([]);
});
it("reset makes every late delivery event inert", () => {
  const old = {};
  const scope = {};
  const state = reduce(initialChatDelivery(old), { type: "reset", scope });
  expect(
    reduce(state, {
      type: "start",
      scope: old,
      message: { id: "old", role: "user", content: "old" },
    }),
  ).toBe(state);
  expect(reduce(state, { type: "retry", scope: old, active: true })).toBe(
    state,
  );
});
it("recovers failed messages under the original idempotency key", () => {
  const scope = {};
  const message = {
    id: "same",
    role: "user" as const,
    content: "Keep my content",
  };
  let state = reduce(initialChatDelivery(scope), {
    type: "start",
    scope,
    message,
  });
  state = reduce(state, {
    type: "settled",
    scope,
    id: message.id,
    accepted: false,
  });
  state = reduce(state, { type: "start", scope, message: state.failed[0]! });
  expect(state.failed).toEqual([]);
  expect(state.pending).toEqual(["same"]);
});
