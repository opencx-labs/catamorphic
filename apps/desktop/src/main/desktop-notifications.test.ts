import type { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NotificationConstructorOptions } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const created: Array<{
    options: NotificationConstructorOptions;
    emitter: EventEmitter;
  }> = [];
  return { created, supported: true, fail: false };
});
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Notification: class extends EventEmitter {
      static isSupported() {
        return state.supported;
      }
      static async getHistory() {
        return [];
      }
      constructor(options: NotificationConstructorOptions) {
        super();
        state.created.push({ options, emitter: this });
      }
      show() {
        if (state.fail) this.emit("failed", {}, "Unavailable");
        else this.emit("show");
      }
    },
  };
});
const {
  desktopNotificationDestination,
  desktopNotificationTransport,
  savePendingNotification,
  takePendingNotification,
} = await import("./desktop-notifications.js");
const roots: string[] = [];
afterEach(() => {
  state.created.length = 0;
  state.supported = true;
  state.fail = false;
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
const event = {
  eventId: "event-1",
  kind: "customization",
  identity: { tenantId: "tenant", externalUserId: "member" },
  projectId: "project",
  title: "Due today",
  body: "Review the draft",
  route: "/?project=project&target=app%3Atodos",
};

describe("native customization notifications", () => {
  it("uses stable OS identity, honors sound preference, and opens the exact local destination on click", async () => {
    const open = vi.fn(async () => {});
    const transport = desktopNotificationTransport({
      prefs: () => ({ desktopNotifications: true, notificationSounds: false }),
      open,
    });
    await transport.send(event);
    await transport.send(event);
    expect(state.created).toHaveLength(1);
    expect(state.created[0]?.options).toMatchObject({
      id: event.eventId,
      groupId: "work:project",
      silent: true,
      title: event.title,
      body: event.body,
    });
    state.created[0]?.emitter.emit("click", {});
    expect(open).toHaveBeenCalledWith({
      projectId: "project",
      title: event.title,
      route: event.route,
    });
    expect(
      desktopNotificationDestination({
        projectId: "project",
        title: event.title,
        route: event.route,
      }),
    ).toEqual({
      projectId: "project",
      title: event.title,
      target: "app:todos",
    });
  });
  it("does not duplicate session notifications or notify when the person's setting is off", async () => {
    let enabled = false;
    const transport = desktopNotificationTransport({
      prefs: () => ({
        desktopNotifications: enabled,
        notificationSounds: true,
      }),
      open: async () => {},
    });
    await transport.send(event);
    enabled = true;
    await transport.send({ ...event, kind: "agent_failed" });
    expect(state.created).toEqual([]);
  });
  it("returns OS failures for durable delivery retry", async () => {
    const transport = desktopNotificationTransport({
      prefs: () => ({ desktopNotifications: true, notificationSounds: true }),
      open: async () => {},
    });
    state.fail = true;
    await expect(transport.send(event)).rejects.toThrow("Unavailable");
    state.fail = false;
    await expect(transport.send(event)).resolves.toBeUndefined();
    expect(state.created).toHaveLength(2);
  });
  it("preserves the exact safe destination through a helper shutdown and consumes it once", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "work-notification-test-"),
    );
    roots.push(root);
    const destination = {
      projectId: "project",
      title: event.title,
      route: event.route,
    };
    savePendingNotification({ userData: root, destination });
    expect(
      fs.statSync(path.join(root, "pending-notification.json")).mode & 0o777,
    ).toBe(0o600);
    expect(takePendingNotification(root)).toEqual(destination);
    expect(takePendingNotification(root)).toBeUndefined();
  });
  it("keeps project ownership and rejects external routes or executable targets", () => {
    for (const route of [
      "https://evil.test",
      "//evil.test",
      "/\\evil.test",
      "/?project=other",
      "/?target=javascript%3Aalert(1)",
      "/?target=command%3Arun-shell",
    ])
      expect(() =>
        desktopNotificationDestination({
          projectId: "project",
          title: "Reminder",
          route,
        }),
      ).toThrow();
    expect(
      desktopNotificationDestination({
        projectId: "project",
        title: "Reminder",
        route: "/?project=project&session=chat",
      }).target,
    ).toBe("catamorphic://chat?project=project&session=chat");
  });
  it("uses existing notification records for cold activation without another delivery", async () => {
    const open = vi.fn(async () => {});
    const resolve = vi.fn(async () => ({
      projectId: "project",
      title: event.title,
      route: event.route,
    }));
    const transport = desktopNotificationTransport({
      prefs: () => ({ desktopNotifications: true, notificationSounds: true }),
      open,
      resolve,
    });
    await transport.restore("event-1");
    expect(resolve).toHaveBeenCalledWith("event-1");
    expect(open).toHaveBeenCalledWith({
      projectId: "project",
      title: event.title,
      route: event.route,
    });
    expect(state.created).toHaveLength(0);
  });
});
