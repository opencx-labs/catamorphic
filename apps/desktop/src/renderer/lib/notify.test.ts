import { afterEach, expect, it, vi } from "vitest";
import { notifyDesktop } from "./notify.js";

afterEach(() => vi.unstubAllGlobals());

it("delivers the first alert after permission is granted and preserves its click target", async () => {
  const shown: Array<{ title: string; body: string; onclick?: () => void }> =
    [];
  class TestNotification {
    static permission = "default";
    static requestPermission = async () => {
      TestNotification.permission = "granted";
      return "granted";
    };
    onclick?: () => void;
    body: string;
    constructor(
      readonly title: string,
      options: { body: string },
    ) {
      this.body = options.body;
      shown.push(this);
    }
  }
  vi.stubGlobal("document", { hasFocus: () => false });
  vi.stubGlobal("Notification", TestNotification);
  const clicked = vi.fn();
  notifyDesktop("Reminder", "Submit application", clicked);
  await vi.waitFor(() => expect(shown).toHaveLength(1));
  expect(shown[0]).toMatchObject({
    title: "Reminder",
    body: "Submit application",
  });
  shown[0]?.onclick?.();
  expect(clicked).toHaveBeenCalledOnce();
});

it.each([true, false])(
  "does not show an OS alert when focused=%s and permission is denied",
  (focused) => {
    const Notification = vi.fn();
    Object.assign(Notification, { permission: "denied" });
    vi.stubGlobal("Notification", Notification);
    vi.stubGlobal("document", { hasFocus: () => focused });
    notifyDesktop("Reminder", "Submit application", vi.fn());
    expect(Notification).not.toHaveBeenCalled();
  },
);
