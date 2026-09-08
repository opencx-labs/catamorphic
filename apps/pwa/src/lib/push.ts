import { authenticatedFetch } from "./api.js";
import type { PwaConnection } from "./store.js";

export function supportsPush(): boolean {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function enablePushForConnections(
  connections: readonly PwaConnection[],
): Promise<number> {
  if (!supportsPush()) throw new Error("Notifications are not supported here.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notifications were not allowed.");
  }
  const registration = await navigator.serviceWorker.ready;
  const supported: Array<{ connection: PwaConnection; publicKey: string }> = [];
  for (const connection of connections) {
    const base = connection.serverUrl.replace(/\/+$/, "");
    const response = await authenticatedFetch({ connectionId: connection.id })(
      `${base}/notifications/push/config`,
    );
    if (!response.ok) continue;
    const config = (await response.json()) as {
      enabled: boolean;
      publicKey: string | null;
    };
    if (config.enabled && config.publicKey) {
      supported.push({ connection, publicKey: config.publicKey });
    }
  }
  const selected =
    supported.find(
      ({ connection }) =>
        new URL(connection.serverUrl).origin === location.origin,
    ) ?? supported[0];
  if (!selected) {
    throw new Error(
      "None of your connected servers support notifications yet.",
    );
  }
  const applicationServerKey = decodeVapidKey(selected.publicKey);
  let subscription = await registration.pushManager.getSubscription();
  if (
    subscription &&
    !sameKey(subscription.options.applicationServerKey, applicationServerKey)
  ) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });
  const serialized = subscription.toJSON();
  let enabled = 0;
  for (const { connection, publicKey } of supported) {
    if (publicKey !== selected.publicKey) continue;
    const base = connection.serverUrl.replace(/\/+$/, "");
    const authFetch = authenticatedFetch({ connectionId: connection.id });
    const response = await authFetch(
      `${base}/notifications/push/subscription`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          endpoint: subscription.endpoint,
          expirationTime: subscription.expirationTime,
          keys: {
            p256dh: serialized.keys?.p256dh,
            auth: serialized.keys?.auth,
          },
        }),
      },
    );
    if (response.ok) enabled += 1;
  }
  if (enabled === 0) throw new Error("The subscription could not be saved.");
  return enabled;
}

function decodeVapidKey(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const bytes = atob(base64);
  const result = new Uint8Array(new ArrayBuffer(bytes.length));
  for (let index = 0; index < bytes.length; index += 1) {
    result[index] = bytes.charCodeAt(index);
  }
  return result;
}

function sameKey(
  left: ArrayBuffer | null,
  right: Uint8Array<ArrayBuffer>,
): boolean {
  if (!left || left.byteLength !== right.byteLength) return false;
  const bytes = new Uint8Array(left);
  return bytes.every((value, index) => value === right[index]);
}
