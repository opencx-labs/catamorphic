import { ipcMain, type WebContents } from "electron";
import { z } from "zod";
import type { PasskeyRequest } from "../shared/passkeys.js";
import { siteOrigin } from "../shared/site-settings.js";

/**
 * Routes a tab's passkey requests (shared/passkeys.ts) to the window that
 * shows the tab. The guest preload reports each modal request as it
 * starts and settles; the window may cancel one it shows. A page that
 * navigates or closes takes its requests with it. Returns the disposer.
 */
export function registerPasskeys(): () => void {
  const pending = new Map<
    string,
    { guest: WebContents; host: WebContents; request: PasskeyRequest }
  >();
  const watched = new Set<number>();

  const settle = (ids: string[]) => {
    const byHost = new Map<WebContents, string[]>();
    for (const id of ids) {
      const entry = pending.get(id);
      if (!entry) continue;
      pending.delete(id);
      byHost.set(entry.host, [...(byHost.get(entry.host) ?? []), id]);
    }
    for (const [host, settled] of byHost)
      if (!host.isDestroyed())
        host.send("catamorphic:passkey-settled", { ids: settled });
  };
  const settleGuest = (guestId: number) =>
    settle(
      [...pending]
        .filter(([, entry]) => entry.request.guestId === guestId)
        .map(([id]) => id),
    );
  const watch = (guest: WebContents) => {
    if (watched.has(guest.id)) return;
    watched.add(guest.id);
    const guestId = guest.id;
    guest.on("did-navigate", () => settleGuest(guestId));
    guest.once("destroyed", () => {
      watched.delete(guestId);
      settleGuest(guestId);
    });
  };

  const startInput = z.object({
    id: z.string().uuid(),
    kind: z.enum(["get", "create"]),
    icon: z.string().max(2048).optional(),
  });
  const onStart = (event: Electron.IpcMainEvent, input: unknown) => {
    const guest = event.sender;
    const parsed = startInput.safeParse(input);
    if (!parsed.success || guest.getType() !== "webview") return;
    const host = guest.hostWebContents;
    const origin = siteOrigin(guest.getURL());
    // A page has one request at a time (Chromium refuses a second as
    // already pending), so a tab shows at most one sheet, the first.
    if (
      !host ||
      host.isDestroyed() ||
      !origin ||
      [...pending.values()].some((entry) => entry.guest === guest)
    )
      return;
    const request: PasskeyRequest = {
      id: parsed.data.id,
      guestId: guest.id,
      origin,
      kind: parsed.data.kind,
      // Page-supplied, so only a web address the sheet can load as an image.
      icon: siteOrigin(parsed.data.icon ?? "") ? parsed.data.icon : undefined,
    };
    watch(guest);
    pending.set(request.id, { guest, host, request });
    host.send("catamorphic:passkey-request", request);
  };
  const onSettle = (event: Electron.IpcMainEvent, input: unknown) => {
    const parsed = z.object({ id: z.string() }).safeParse(input);
    if (!parsed.success) return;
    if (pending.get(parsed.data.id)?.guest === event.sender)
      settle([parsed.data.id]);
  };
  ipcMain.on("catamorphic:passkey-start", onStart);
  ipcMain.on("catamorphic:passkey-settle", onSettle);
  ipcMain.handle(
    "catamorphic:passkey-cancel",
    (event, input: unknown): boolean => {
      const { id } = z.object({ id: z.string() }).parse(input);
      const entry = pending.get(id);
      // Only the window showing the request may cancel it.
      if (!entry || entry.host !== event.sender || entry.guest.isDestroyed())
        return false;
      entry.guest.send("catamorphic:passkey-cancel", id);
      return true;
    },
  );

  return () => {
    ipcMain.removeListener("catamorphic:passkey-start", onStart);
    ipcMain.removeListener("catamorphic:passkey-settle", onSettle);
    ipcMain.removeHandler("catamorphic:passkey-cancel");
    pending.clear();
  };
}
