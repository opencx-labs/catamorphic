import { EventEmitter } from "node:events";
import { app, type WebContents, type WebFrameMain } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatForVoiceShortcut,
  listenForVoiceKeys,
  profileForVoiceContents,
  voiceFrameContext,
} from "./voice-keys.js";

const pages = vi.hoisted(() => [] as WebContents[]);
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: new EventEmitter(),
    webContents: { getAllWebContents: () => pages },
  };
});

function page() {
  const contents = Object.assign(new EventEmitter(), {
    destroyed: false,
    hostWebContents: null as WebContents | null,
    isDestroyed: () => contents.destroyed,
  });
  const sender = contents as unknown as WebContents;
  return { contents, sender };
}

const keyDown = (key = "a", code = "KeyA", alt = false) => ({
  type: "keyDown",
  key,
  code,
  alt,
  meta: false,
  control: false,
  shift: false,
  isAutoRepeat: false,
});

const disposers: Array<() => void> = [];
beforeEach(() => {
  pages.length = 0;
  app.removeAllListeners();
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

describe("voice shortcuts in browsing popups", () => {
  it("resolves prepared browsing ownership without giving a popup shell authority", () => {
    const shell = page();
    const popup = page();
    const unknown = page();
    const shellProfileFor = vi.fn((contents: WebContents) => {
      if (contents === shell.sender) return "work-profile";
      throw new Error("This action requires a registered Work profile.");
    });
    const browserProfileFor = vi.fn((contents: WebContents) =>
      contents === popup.sender ? "browser-profile" : undefined,
    );
    const profileFor = (contents: WebContents) =>
      profileForVoiceContents({ contents, shellProfileFor, browserProfileFor });
    expect(profileFor(shell.sender)).toBe("work-profile");
    expect(profileFor(popup.sender)).toBe("browser-profile");
    expect(profileFor(unknown.sender)).toBeUndefined();
    popup.contents.destroyed = true;
    browserProfileFor.mockClear();
    expect(profileFor(popup.sender)).toBeUndefined();
    expect(browserProfileFor).not.toHaveBeenCalled();
  });

  it("keeps sign-in typing working with a strict shell registry and uses its browsing profile for voice", () => {
    const popup = page();
    const unknown = page();
    pages.push(popup.sender, unknown.sender);
    const down = vi.fn();
    const up = vi.fn();
    const keysFor = (contents: WebContents) => {
      const profileId = profileForVoiceContents({
        contents,
        shellProfileFor: () => {
          throw new Error("Unregistered shell");
        },
        browserProfileFor: (candidate) =>
          candidate === popup.sender ? "browser-profile" : undefined,
      });
      return profileId
        ? { profileId, shortcuts: { dictate: "Alt+Space" } }
        : null;
    };
    disposers.push(listenForVoiceKeys({ keysFor, down, up }));
    expect(() =>
      popup.contents.emit("before-input-event", {}, keyDown()),
    ).not.toThrow();
    expect(() =>
      unknown.contents.emit(
        "before-input-event",
        {},
        keyDown(" ", "Space", true),
      ),
    ).not.toThrow();
    expect(down).not.toHaveBeenCalled();
    popup.contents.emit("before-input-event", {}, keyDown(" ", "Space", true));
    expect(down).toHaveBeenCalledExactlyOnceWith(
      "browser-profile",
      "dictate",
      popup.sender,
    );
    popup.contents.emit(
      "before-input-event",
      {},
      { ...keyDown(" ", "Space", true), type: "keyUp" },
    );
    expect(up).toHaveBeenCalledExactlyOnceWith("dictate");
  });

  it("looks up hosted pages themselves and routes an accepted press through their owner", () => {
    const owner = page();
    const guest = page();
    guest.contents.hostWebContents = owner.sender;
    const keysFor = vi.fn((contents: WebContents) =>
      contents === guest.sender
        ? { profileId: "browser-profile", shortcuts: { dictate: "Alt+Space" } }
        : null,
    );
    const down = vi.fn();
    const dispose = listenForVoiceKeys({ keysFor, down, up: vi.fn() });
    disposers.push(dispose);
    app.emit("web-contents-created", {}, guest.sender);
    guest.contents.emit("before-input-event", {}, keyDown(" ", "Space", true));
    expect(keysFor).toHaveBeenCalledWith(guest.sender);
    expect(down).toHaveBeenCalledExactlyOnceWith(
      "browser-profile",
      "dictate",
      owner.sender,
    );
    dispose();
    expect(guest.contents.listenerCount("before-input-event")).toBe(0);
  });
});

describe("native guest voice messages", () => {
  it("accepts live nested frames and ignores unknown, detached, stale and destroyed senders", () => {
    const top = { isDestroyed: () => false };
    const frame = { detached: false, isDestroyed: () => false, top };
    const contents = {
      isDestroyed: () => false,
      mainFrame: top,
    } as unknown as WebContents;
    const event = {
      sender: contents,
      senderFrame: frame as unknown as WebFrameMain,
    } as Electron.IpcMainEvent;
    const profileFor = vi.fn(() => "browser-profile");
    expect(voiceFrameContext({ event, profileFor })).toEqual({
      frame,
      profileId: "browser-profile",
    });
    expect(
      voiceFrameContext({ event, profileFor: () => undefined }),
    ).toBeNull();
    frame.detached = true;
    expect(voiceFrameContext({ event, profileFor })).toBeNull();
    frame.detached = false;
    frame.top = { isDestroyed: () => false };
    expect(voiceFrameContext({ event, profileFor })).toBeNull();
    frame.top = top;
    frame.isDestroyed = () => true;
    expect(voiceFrameContext({ event, profileFor })).toBeNull();
    expect(
      voiceFrameContext({ event: { ...event, senderFrame: null }, profileFor }),
    ).toBeNull();
  });
});

describe("voice shortcut chat ownership", () => {
  it("never borrows a chat from another project in the same profile", () => {
    const other = {
      profileId: "profile",
      projectId: "other-project",
      sessionId: "other-chat",
    };
    const here = { ...other, projectId: "here", sessionId: "here-chat" };
    const input = {
      profileId: "profile",
      projectId: "here",
      profileForProject: () => "profile",
    };
    expect(
      chatForVoiceShortcut({ ...input, frontChat: other, lastChat: other }),
    ).toBeUndefined();
    expect(
      chatForVoiceShortcut({ ...input, frontChat: undefined, lastChat: here }),
    ).toEqual({ projectId: "here", sessionId: "here-chat" });
  });

  it("keeps a popup's fallback in its profile and rejects stale window chats after a profile switch", () => {
    const first = {
      profileId: "first",
      projectId: "project-first",
      sessionId: "chat-first",
    };
    const second = {
      profileId: "second",
      projectId: "project-second",
      sessionId: "chat-second",
    };
    const profileForProject = (projectId: string) =>
      projectId === first.projectId ? "first" : "second";
    expect(
      chatForVoiceShortcut({
        profileId: "second",
        frontChat: first,
        lastChat: first,
        profileForProject,
      }),
    ).toBeUndefined();
    expect(
      chatForVoiceShortcut({
        profileId: "second",
        frontChat: first,
        lastChat: second,
        profileForProject,
      }),
    ).toEqual({ projectId: second.projectId, sessionId: second.sessionId });
    expect(
      chatForVoiceShortcut({
        profileId: "first",
        frontChat: first,
        lastChat: undefined,
        profileForProject,
      }),
    ).toEqual({ projectId: first.projectId, sessionId: first.sessionId });
  });

  it("rechecks project ownership when a project moves to another profile", () => {
    const previous = {
      profileId: "first",
      projectId: "moved",
      sessionId: "old-chat",
    };
    const current = {
      profileId: "first",
      projectId: "remaining",
      sessionId: "current-chat",
    };
    const profileForProject = (projectId: string) =>
      projectId === "moved" ? "second" : "first";
    expect(
      chatForVoiceShortcut({
        profileId: "first",
        frontChat: previous,
        lastChat: previous,
        profileForProject,
      }),
    ).toBeUndefined();
    expect(
      chatForVoiceShortcut({
        profileId: "first",
        frontChat: previous,
        lastChat: current,
        profileForProject,
      }),
    ).toEqual({ projectId: current.projectId, sessionId: current.sessionId });
  });
});
