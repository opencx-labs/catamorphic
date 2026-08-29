import fs from "node:fs";
import path from "node:path";
import type { PushNotificationTransport } from "@catamorphic/core";
import webPush from "web-push";

interface PersistedVapidKeys {
  publicKey: string;
  privateKey: string;
}

export function createPushTransport(args: {
  dataDir: string;
  subject?: string;
}): PushNotificationTransport {
  const file = path.join(args.dataDir, "web-push-vapid.json");
  const keys = loadOrCreateKeys(file);
  const subject = args.subject ?? "mailto:notifications@catamorphic.local";
  return {
    publicKey: keys.publicKey,
    async send({ subscription, payload }) {
      try {
        await webPush.sendNotification(subscription, payload, {
          TTL: 300,
          vapidDetails: {
            subject,
            publicKey: keys.publicKey,
            privateKey: keys.privateKey,
          },
        });
        return "delivered";
      } catch (error) {
        const statusCode =
          typeof error === "object" && error !== null && "statusCode" in error
            ? Number(error.statusCode)
            : 0;
        if (statusCode === 404 || statusCode === 410) return "retired";
        throw error;
      }
    },
  };
}

function loadOrCreateKeys(file: string): PersistedVapidKeys {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "publicKey" in parsed &&
      typeof parsed.publicKey === "string" &&
      "privateKey" in parsed &&
      typeof parsed.privateKey === "string"
    ) {
      return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const keys = webPush.generateVAPIDKeys();
  try {
    fs.writeFileSync(file, `${JSON.stringify(keys)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return keys;
  } catch (error) {
    // Two same-data-dir processes can race on first boot. The winner's key
    // pair is canonical; the loser reads it instead of failing startup.
    if (isAlreadyExists(error)) return loadOrCreateKeys(file);
    throw error;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
