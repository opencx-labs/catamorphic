import { describe, expect, it } from "vitest";
import { microphonesOf } from "./microphones.js";

const input = (deviceId: string, groupId: string, label: string) => ({
  kind: "audioinput" as const,
  deviceId,
  groupId,
  label,
});

describe("microphonesOf", () => {
  it("lists real microphones, the one the system uses marked default", () => {
    expect(
      microphonesOf([
        input("default", "g1", "Default - MacBook Pro Microphone (Built-in)"),
        input("communications", "g2", "Communications - Headset"),
        input("built-in", "g1", "MacBook Pro Microphone (Built-in)"),
        input("headset", "g2", "Headset"),
        { kind: "audiooutput", deviceId: "speakers", groupId: "g1", label: "" },
      ]),
    ).toEqual([
      {
        id: "built-in",
        label: "MacBook Pro Microphone (Built-in)",
        isDefault: true,
      },
      { id: "headset", label: "Headset", isDefault: false },
    ]);
  });

  it("tells two microphones of one device apart by name", () => {
    expect(
      microphonesOf([
        input("default", "usb", "Default - Interface Input 2"),
        input("one", "usb", "Interface Input 1"),
        input("two", "usb", "Interface Input 2"),
      ]).map((microphone) => microphone.isDefault),
    ).toEqual([false, true]);
  });

  it("marks none without the system's alias, and names an unnamed one", () => {
    expect(microphonesOf([input("only", "g", "")])).toEqual([
      { id: "only", label: "Microphone 1", isDefault: false },
    ]);
  });
});
