import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cookieCoversHost,
  SitePermissionBroker,
  SiteSettingsStore,
} from "./site-settings.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "site-settings-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("SiteSettingsStore", () => {
  it("stores only explicit choices, per profile and origin", () => {
    const store = new SiteSettingsStore(dir);
    expect(store.get("p1", "https://a.test")).toEqual({});
    store.set("p1", "https://a.test", "microphone", "allow");
    store.set("p1", "https://a.test", "camera", "block");
    expect(store.get("p1", "https://a.test")).toEqual({
      microphone: "allow",
      camera: "block",
    });
    expect(store.get("p2", "https://a.test")).toEqual({});
    expect(store.origins("p1")).toEqual(["https://a.test"]);

    const reloaded = new SiteSettingsStore(dir);
    expect(reloaded.get("p1", "https://a.test")).toEqual({
      microphone: "allow",
      camera: "block",
    });
    expect(fs.existsSync(path.join(dir, "p1", "site-settings.json"))).toBe(
      true,
    );
  });

  it("drops a choice that returns to the default, and empty sites", () => {
    const store = new SiteSettingsStore(dir);
    store.set("p1", "https://a.test", "microphone", "allow");
    store.set("p1", "https://a.test", "microphone", "ask");
    expect(store.get("p1", "https://a.test")).toEqual({});
    expect(store.origins("p1")).toEqual([]);

    store.set("p1", "https://a.test", "fullscreen", "allow");
    expect(store.origins("p1")).toEqual([]);
    store.set("p1", "https://a.test", "fullscreen", "block");
    store.set("p1", "https://a.test", "fullscreen", null);
    expect(store.origins("p1")).toEqual([]);
  });

  it("resets a site", () => {
    const store = new SiteSettingsStore(dir);
    store.set("p1", "https://a.test", "location", "block");
    store.set("p1", "https://b.test", "location", "allow");
    store.reset("p1", "https://a.test");
    expect(store.origins("p1")).toEqual(["https://b.test"]);
  });

  it("ignores unknown kinds and states on disk", () => {
    fs.mkdirSync(path.join(dir, "p1"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "p1", "site-settings.json"),
      JSON.stringify({
        sites: {
          "https://a.test": { microphone: "allow", bogus: "allow" },
          "https://b.test": { camera: "maybe" },
          "https://c.test": "nope",
        },
      }),
    );
    const store = new SiteSettingsStore(dir);
    expect(store.get("p1", "https://a.test")).toEqual({ microphone: "allow" });
    expect(store.get("p1", "https://b.test")).toEqual({});
    expect(store.origins("p1")).toEqual(["https://a.test"]);
  });
});

describe("cookieCoversHost", () => {
  it("matches host, domain, parent-domain and subdomain cookies", () => {
    expect(cookieCoversHost("chatgpt.com", "chatgpt.com")).toBe(true);
    expect(cookieCoversHost(".chatgpt.com", "chatgpt.com")).toBe(true);
    expect(cookieCoversHost(".openai.com", "chat.openai.com")).toBe(true);
    expect(cookieCoversHost("api.chatgpt.com", "chatgpt.com")).toBe(true);
    expect(cookieCoversHost(".chatgpt.com", "notchatgpt.com")).toBe(false);
    expect(cookieCoversHost("example.com", "chatgpt.com")).toBe(false);
    expect(cookieCoversHost("localhost", "localhost:3000")).toBe(true);
  });
});

describe("SitePermissionBroker", () => {
  it("delivers a request and resolves with the answer", async () => {
    const broker = new SitePermissionBroker();
    let delivered: { id: string; kinds: string[] } | null = null;
    const answered = broker.askPermission(
      {
        profileId: "p1",
        origin: "https://a.test",
        guestId: 7,
        kinds: ["microphone"],
      },
      (request) => {
        delivered = request;
      },
    );
    expect(delivered).not.toBeNull();
    const id = (delivered as unknown as { id: string }).id;
    expect(broker.has(id)).toBe(true);
    // Another profile's window cannot answer it.
    expect(
      broker.answer(id, { id, decision: "allow", remember: true }, "p2"),
    ).toBeNull();
    expect(broker.has(id)).toBe(true);
    expect(
      broker.answer(id, { id, decision: "allow", remember: true }, "p1"),
    ).toEqual({
      profileId: "p1",
      request: {
        id,
        guestId: 7,
        origin: "https://a.test",
        kinds: ["microphone"],
      },
    });
    await expect(answered).resolves.toEqual({
      id,
      decision: "allow",
      remember: true,
    });
    expect(broker.has(id)).toBe(false);
    expect(
      broker.answer(id, { id, decision: "block", remember: false }),
    ).toBeNull();
  });

  it("denies the requests of a guest that goes away", async () => {
    const broker = new SitePermissionBroker();
    const ids: string[] = [];
    const first = broker.askPermission(
      { profileId: "p1", origin: "https://a.test", guestId: 7, kinds: [] },
      (request) => ids.push(request.id),
    );
    const other = broker.askPermission(
      { profileId: "p1", origin: "https://b.test", guestId: 8, kinds: [] },
      (request) => ids.push(request.id),
    );
    expect(broker.withdrawGuest(7)).toEqual([ids[0]]);
    await expect(first).resolves.toBeNull();
    expect(broker.has(ids[1] ?? "")).toBe(true);
    broker.withdrawGuest(8);
    await expect(other).resolves.toBeNull();
  });

  it("withdraws a tab's requests to open another app when it navigates", async () => {
    const broker = new SitePermissionBroker();
    const ids: string[] = [];
    const openApp = broker.askPermission(
      {
        profileId: "p1",
        origin: "https://team.slack.test",
        guestId: 7,
        kinds: ["externalApps"],
        externalApp: { scheme: "slack", name: "Slack" },
      },
      (request) => ids.push(request.id),
    );
    const camera = broker.askPermission(
      { profileId: "p1", origin: "https://a.test", guestId: 7, kinds: [] },
      (request) => ids.push(request.id),
    );
    expect(broker.withdrawExternalApps(7)).toEqual([ids[0]]);
    await expect(openApp).resolves.toBeNull();
    expect(broker.has(ids[1] ?? "")).toBe(true);
    broker.withdrawGuest(7);
    await expect(camera).resolves.toBeNull();
  });

  it("undoes a delivery's attention request once the prompt settles", async () => {
    const broker = new SitePermissionBroker();
    let attention = 0;
    let id = "";
    const pending = broker.askPermission(
      { profileId: "p1", origin: "https://a.test", guestId: 7, kinds: [] },
      (request) => {
        id = request.id;
        attention++;
        return () => {
          attention--;
        };
      },
    );
    expect(attention).toBe(1);
    broker.answer(id, { id, decision: "allow", remember: false });
    await pending;
    expect(attention).toBe(0);
  });
});
