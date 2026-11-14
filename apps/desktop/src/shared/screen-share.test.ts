import { describe, expect, it } from "vitest";
import {
  shareStreams,
  systemAudioSupported,
  tabSourceWebContentsId,
} from "./screen-share.js";

const frame = { frame: "tab" };
const tab = { id: "tab:7", kind: "tab" as const, name: "Docs" };
const screen = { id: "screen:1:0", kind: "screen" as const, name: "Screen" };
const window = { id: "window:9:0", kind: "window" as const, name: "Notes" };

describe("shareStreams", () => {
  it("gives a tab its own audio only when asked for and left on", () => {
    expect(
      shareStreams({
        choice: { ...tab, audio: true },
        tabFrame: frame,
        audioRequested: true,
        systemAudio: false,
      }),
    ).toEqual({ video: frame, audio: frame, enableLocalEcho: true });
    expect(
      shareStreams({
        choice: { ...tab, audio: false },
        tabFrame: frame,
        audioRequested: true,
        systemAudio: false,
      }),
    ).toEqual({ video: frame });
    expect(
      shareStreams({
        choice: { ...tab, audio: true },
        tabFrame: frame,
        audioRequested: false,
        systemAudio: true,
      }),
    ).toEqual({ video: frame });
  });

  it("refuses a tab whose page is gone", () => {
    expect(
      shareStreams({
        choice: { ...tab, audio: true },
        tabFrame: null,
        audioRequested: true,
        systemAudio: true,
      }),
    ).toBeNull();
  });

  it("mixes in system audio with a screen where the OS can", () => {
    const video = { id: screen.id, name: screen.name };
    expect(
      shareStreams({
        choice: { ...screen, audio: true },
        tabFrame: null,
        audioRequested: true,
        systemAudio: true,
      }),
    ).toEqual({ video, audio: "loopback" });
    expect(
      shareStreams({
        choice: { ...screen, audio: true },
        tabFrame: null,
        audioRequested: true,
        systemAudio: false,
      }),
    ).toEqual({ video });
    expect(
      shareStreams({
        choice: { ...screen, audio: false },
        tabFrame: null,
        audioRequested: true,
        systemAudio: true,
      }),
    ).toEqual({ video });
  });

  it("shares a window without sound", () => {
    expect(
      shareStreams({
        choice: { ...window, audio: true },
        tabFrame: null,
        audioRequested: true,
        systemAudio: true,
      }),
    ).toEqual({ video: { id: window.id, name: window.name } });
  });
});

describe("systemAudioSupported", () => {
  it("is Windows, and macOS 14.2 or later with the usage description", () => {
    const mac = (osVersion: string, declaresAudioCapture = true) =>
      systemAudioSupported({
        platform: "darwin",
        osVersion,
        declaresAudioCapture,
      });
    expect(mac("14.2")).toBe(true);
    expect(mac("14.2.1")).toBe(true);
    expect(mac("15.0")).toBe(true);
    expect(mac("26.7.3")).toBe(true);
    expect(mac("14.1.2")).toBe(false);
    expect(mac("13.6")).toBe(false);
    expect(mac("26.0", false)).toBe(false);
    expect(
      systemAudioSupported({
        platform: "win32",
        osVersion: "10.0.22631",
        declaresAudioCapture: false,
      }),
    ).toBe(true);
    expect(
      systemAudioSupported({
        platform: "linux",
        osVersion: "6.8.0",
        declaresAudioCapture: true,
      }),
    ).toBe(false);
  });
});

describe("tabSourceWebContentsId", () => {
  it("reads a tab source's page id", () => {
    expect(tabSourceWebContentsId("tab:42")).toBe(42);
    expect(tabSourceWebContentsId("screen:1:0")).toBeNull();
    expect(tabSourceWebContentsId("tab:x")).toBeNull();
  });
});
