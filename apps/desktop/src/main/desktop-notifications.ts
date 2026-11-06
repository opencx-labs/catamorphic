import fs from "node:fs";
import path from "node:path";
import type { UserNotificationTransport } from "@catamorphic/core";
import { Notification } from "electron";
import { z } from "zod";
import {
  chatBookmarkUrl,
  parseChatBookmarkUrl,
} from "../shared/bookmark-target.js";
import { parseSurfaceLink } from "../shared/surface-link.js";

const destinationSchema = z.object({
  projectId: z.string().min(1),
  route: z.string().min(1).max(2048),
  title: z.string().max(200),
});
export type DesktopNotificationDestination = z.infer<typeof destinationSchema>;

/** Host-local routes resolve through the desktop's ordinary resource links. */
export function desktopNotificationDestination(
  input: DesktopNotificationDestination,
) {
  destinationSchema.parse(input);
  if (
    !input.route.startsWith("/") ||
    input.route.startsWith("//") ||
    input.route.includes("\\") ||
    [...input.route].some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error("A notification must open a local route.");
  const route = new URL(input.route, "https://work.invalid");
  if (route.origin !== "https://work.invalid")
    throw new Error("A notification must open a local route.");
  const project = route.searchParams.get("project");
  if (project && project !== input.projectId)
    throw new Error("A notification belongs to its own project.");
  const session = route.searchParams.get("session");
  const named = ["app", "workflow", "artifact", "run"].flatMap((kind) => {
    const name = route.searchParams.get(kind);
    return name ? [`${kind}:${encodeURIComponent(name)}`] : [];
  });
  const target =
    route.searchParams.get("target") ??
    named[0] ??
    (session
      ? chatBookmarkUrl({ projectId: input.projectId, sessionId: session })
      : undefined);
  if (target) {
    const chat = parseChatBookmarkUrl(target);
    if (chat ? chat.projectId !== input.projectId : !parseSurfaceLink(target))
      throw new Error(
        "This notification destination is not a workspace resource.",
      );
  }
  return { projectId: input.projectId, target, title: input.title };
}

/** A click survives the clean background-to-foreground engine transfer. */
export function savePendingNotification(input: {
  userData: string;
  destination: DesktopNotificationDestination;
}) {
  desktopNotificationDestination(input.destination);
  const file = path.join(input.userData, "pending-notification.json");
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(input.destination), {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}
export function takePendingNotification(
  userData: string,
): DesktopNotificationDestination | undefined {
  const file = path.join(userData, "pending-notification.json");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
  const destination = destinationSchema.parse(JSON.parse(text));
  desktopNotificationDestination(destination);
  fs.unlinkSync(file);
  return destination;
}

/** Durable customization events use the native OS transport once, without a model turn. */
export function desktopNotificationTransport(input: {
  prefs: (projectId: string) => {
    desktopNotifications: boolean;
    notificationSounds: boolean;
  };
  open: (destination: DesktopNotificationDestination) => Promise<void>;
  resolve?: (
    eventId: string,
  ) => Promise<DesktopNotificationDestination | undefined>;
}): UserNotificationTransport & { restore(eventId?: string): Promise<void> } {
  const live = new Map<string, Notification>();
  const attach = (
    eventId: string,
    notification: Notification,
    destination: DesktopNotificationDestination,
  ) => {
    live.set(eventId, notification);
    notification.once("click", () => {
      live.delete(eventId);
      void input
        .open(destination)
        .catch((error: unknown) =>
          console.warn("[desktop] Notification could not open:", error),
        );
    });
    notification.once("close", () => live.delete(eventId));
  };
  return {
    restore: async (eventId) => {
      if (!input.resolve) return;
      if (eventId) {
        const destination = await input.resolve(eventId);
        if (destination) {
          desktopNotificationDestination(destination);
          await input.open(destination);
        }
      }
      if (process.platform !== "darwin" || !Notification.isSupported()) return;
      for (const notification of await Notification.getHistory()) {
        const destination = await input.resolve(notification.id);
        if (destination) {
          desktopNotificationDestination(destination);
          attach(notification.id, notification, destination);
        }
      }
    },
    send: async (event) => {
      // Sessions already notify through the renderer; do not duplicate those.
      if (
        !("kind" in event) ||
        event.kind !== "customization" ||
        !event.projectId
      )
        return;
      const prefs = input.prefs(event.projectId);
      if (!prefs.desktopNotifications) return;
      const destination = {
        projectId: event.projectId,
        route: event.route,
        title: event.title,
      };
      desktopNotificationDestination(destination);
      if (!Notification.isSupported())
        throw new Error("OS notifications are unavailable.");
      if (live.has(event.eventId)) return;
      const notification = new Notification({
        id: event.eventId,
        groupId: `work:${event.projectId}`,
        title: event.title,
        body: event.body,
        silent: !prefs.notificationSounds,
      });
      attach(event.eventId, notification, destination);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          live.delete(event.eventId);
          reject(new Error("OS notification delivery timed out."));
        }, 15_000);
        notification.once("show", () => {
          clearTimeout(timeout);
          resolve();
        });
        notification.once("failed", (_event, error) => {
          clearTimeout(timeout);
          live.delete(event.eventId);
          reject(new Error(error));
        });
        try {
          notification.show();
        } catch (error) {
          clearTimeout(timeout);
          live.delete(event.eventId);
          reject(error);
        }
      });
    },
  };
}
