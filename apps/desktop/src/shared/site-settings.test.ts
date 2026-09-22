import { describe, expect, it } from "vitest";
import {
  customizedKinds,
  decideSitePermission,
  describeRequest,
  effectivePermission,
  permissionKindsFor,
  siteHost,
  siteOrigin,
} from "./site-settings.js";

describe("site permission vocabulary", () => {
  it("maps Electron permissions onto site permission kinds", () => {
    expect(permissionKindsFor("geolocation")).toEqual(["location"]);
    expect(permissionKindsFor("notifications")).toEqual(["notifications"]);
    expect(permissionKindsFor("media", { mediaTypes: ["audio"] })).toEqual([
      "microphone",
    ]);
    expect(
      permissionKindsFor("media", { mediaTypes: ["audio", "video"] }),
    ).toEqual(["microphone", "camera"]);
    expect(permissionKindsFor("media")).toEqual(["microphone", "camera"]);
    expect(permissionKindsFor("midiSysex")).toEqual(["midi"]);
    expect(permissionKindsFor("openExternal")).toEqual(["externalApps"]);
    expect(permissionKindsFor("hid")).toEqual([]);
  });

  it("asks by default for device-level kinds and allows fullscreen", () => {
    expect(effectivePermission({}, "microphone")).toBe("ask");
    expect(effectivePermission({}, "fullscreen")).toBe("allow");
    expect(effectivePermission({ fullscreen: "block" }, "fullscreen")).toBe(
      "block",
    );
  });

  it("decides without a prompt when every kind is settled", () => {
    expect(decideSitePermission({}, "fullscreen")).toEqual({
      outcome: "allow",
    });
    expect(decideSitePermission({}, "clipboard-sanitized-write")).toEqual({
      outcome: "allow",
    });
    expect(
      decideSitePermission({ microphone: "allow" }, "media", {
        mediaTypes: ["audio"],
      }),
    ).toEqual({ outcome: "allow" });
    expect(decideSitePermission({}, "unknown-thing")).toEqual({
      outcome: "block",
    });
  });

  it("blocks the whole request when any kind is blocked", () => {
    expect(
      decideSitePermission({ camera: "block", microphone: "allow" }, "media", {
        mediaTypes: ["audio", "video"],
      }),
    ).toEqual({ outcome: "block" });
  });

  it("asks only for the kinds still undecided", () => {
    expect(
      decideSitePermission({ microphone: "allow" }, "media", {
        mediaTypes: ["audio", "video"],
      }),
    ).toEqual({ outcome: "ask", kinds: ["camera"] });
    expect(decideSitePermission({}, "geolocation")).toEqual({
      outcome: "ask",
      kinds: ["location"],
    });
  });

  it("lists only choices away from the default", () => {
    expect(
      customizedKinds({
        fullscreen: "allow",
        microphone: "allow",
        location: "ask",
        camera: "block",
      }),
    ).toEqual(["camera", "microphone"]);
  });

  it("phrases what a request wants", () => {
    expect(describeRequest(["microphone"])).toBe("use your microphone");
    expect(describeRequest(["microphone", "camera"])).toBe(
      "use your microphone and camera",
    );
    expect(describeRequest(["location", "notifications"])).toBe(
      "know your location and send you notifications",
    );
  });

  it("names sites by origin and host", () => {
    expect(siteOrigin("https://chatgpt.com/c/123?x=1")).toBe(
      "https://chatgpt.com",
    );
    expect(siteOrigin("http://localhost:3000/app")).toBe(
      "http://localhost:3000",
    );
    expect(siteOrigin("data:text/html,hi")).toBeNull();
    expect(siteOrigin("about:blank")).toBeNull();
    expect(siteOrigin("not a url")).toBeNull();
    expect(siteHost("https://chatgpt.com")).toBe("chatgpt.com");
    expect(siteHost("http://localhost:3000")).toBe("localhost:3000");
  });
});
