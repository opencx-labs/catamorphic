// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installPageActivation } from "./page-activation.js";

const listeners = new Map<string, EventListener>();
const activation = { hasBeenActive: false };
const original = Object.getOwnPropertyDescriptor(navigator, "userActivation");
let stop: () => void;
let report = vi.fn<() => void>();
beforeEach(() => {
  activation.hasBeenActive = false;
  Object.defineProperty(navigator, "userActivation", {
    configurable: true,
    value: activation,
  });
  vi.spyOn(window, "addEventListener").mockImplementation((type, listener) => {
    listeners.set(type, listener as EventListener);
  });
  report = vi.fn<() => void>();
  stop = installPageActivation(report);
});
afterEach(() => {
  stop();
  listeners.clear();
  vi.restoreAllMocks();
  if (original) Object.defineProperty(navigator, "userActivation", original);
  else Reflect.deleteProperty(navigator, "userActivation");
});
const emit = (type: string, trusted = true, key?: string) => {
  const event = Object.create(key ? KeyboardEvent.prototype : Event.prototype);
  Object.defineProperties(event, {
    isTrusted: { value: trusted },
    key: { value: key },
  });
  listeners.get(type)?.(event);
};

it("ignores synthetic input and inert keys, and reports real interaction once", () => {
  emit("pointerdown", false);
  emit("keydown", true, "Control");
  emit("keydown", true, "Escape");
  expect(report).not.toHaveBeenCalled();
  emit("keydown", true, "a");
  emit("beforeinput");
  emit("pointerdown");
  expect(report).toHaveBeenCalledOnce();
});

it("restores sticky activation when a document returns from history", () => {
  emit("pointerdown");
  activation.hasBeenActive = true;
  emit("pageshow");
  expect(report).toHaveBeenCalledTimes(2);
  emit("beforeinput");
  expect(report).toHaveBeenCalledTimes(2);
});

it("a fresh document still waits for real input, and synthetic pageshow cannot reset it", () => {
  emit("pointerdown");
  emit("pageshow", false);
  emit("pointerdown");
  expect(report).toHaveBeenCalledOnce();
  emit("pageshow");
  expect(report).toHaveBeenCalledOnce();
  emit("beforeinput");
  expect(report).toHaveBeenCalledTimes(2);
});
