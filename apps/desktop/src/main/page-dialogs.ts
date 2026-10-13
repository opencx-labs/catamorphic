import { randomUUID } from "node:crypto";
import {
  isScriptDialog,
  type PageDialog,
  type PageDialogAnswer,
  type PageDialogKind,
} from "../shared/page-dialogs.js";

/**
 * The dialogs pages in browser tabs are waiting on (ADR 0226): a queue per
 * page, of which the window shows the first. Pure bookkeeping, keyed by the
 * guest's WebContents id, so it runs without Electron in tests; the
 * Electron side (browser-dialogs.ts) asks, and settles what the person or
 * an agent answers, or what a navigation or a closed tab takes back.
 */

export type PageDialogRequest = Omit<PageDialog, "id" | "canSuppress">;

/**
 * A page asking more than this at once (frames, sign-ins for different
 * realms) gets the rest cancelled: nobody answers dozens of dialogs.
 */
export const PAGE_DIALOG_QUEUE_LIMIT = 20;

interface Entry {
  dialog: PageDialog;
  /** The frame that asked (frameTreeNodeId); its navigation takes it back. */
  frame: number | null;
  settle: (answer: PageDialogAnswer | null) => void;
}

interface PageState {
  queue: Entry[];
  /** Script dialogs this page load has asked (Chrome's repeated-dialog rule). */
  asked: number;
  /** "Don't let this page show more dialogs", until another page loads. */
  suppressed: boolean;
}

export class PageDialogs {
  private pages = new Map<number, PageState>();
  private byId = new Map<string, number>();
  private openListeners = new Map<number, Set<(dialog: PageDialog) => void>>();

  constructor(
    /** The page's dialogs changed: tell the window that shows its tab. */
    private readonly publish: (guestId: number, dialogs: PageDialog[]) => void,
  ) {}

  /**
   * Ask the person, in the page's tab. Resolves with the answer, or null
   * when nobody will answer: the page was told to show no more dialogs, it
   * navigated, or its tab closed, or it already waits on too many. Script
   * dialogs from the second on offer to stop the page's dialogs, as Chrome
   * does.
   */
  ask(
    request: PageDialogRequest,
    options: {
      frame?: number | null;
      /** Called with the dialog as it joins the page's queue. */
      queued?: (dialog: PageDialog) => void;
    } = {},
  ): Promise<PageDialogAnswer | null> {
    const page = this.page(request.guestId);
    const script = isScriptDialog(request.kind);
    if (script && page.suppressed) return Promise.resolve(null);
    if (page.queue.length >= PAGE_DIALOG_QUEUE_LIMIT)
      return Promise.resolve(null);
    const canSuppress = script && page.asked > 0;
    if (script) page.asked += 1;
    return new Promise((resolve) => {
      const dialog: PageDialog = { ...request, id: randomUUID(), canSuppress };
      page.queue.push({
        dialog,
        frame: options.frame ?? null,
        settle: resolve,
      });
      this.byId.set(dialog.id, request.guestId);
      options.queued?.(dialog);
      this.changed(request.guestId);
      for (const listener of this.openListeners.get(request.guestId) ?? [])
        listener(dialog);
    });
  }

  /**
   * Settle a dialog with its answer. Returns the dialog answered, or null
   * when it is no longer open (answered elsewhere, or taken back).
   */
  answer(answer: PageDialogAnswer): PageDialog | null {
    const guestId = this.byId.get(answer.id);
    if (guestId === undefined) return null;
    const page = this.pages.get(guestId);
    const entry = page?.queue.find((item) => item.dialog.id === answer.id);
    if (!page || !entry) return null;
    if (answer.suppress && isScriptDialog(entry.dialog.kind))
      page.suppressed = true;
    this.remove(guestId, [entry]);
    entry.settle(answer);
    return entry.dialog;
  }

  /**
   * Change an open dialog in place: a second "Leave site?" for one page, or
   * a prompt's field as an agent fills it.
   */
  update(
    id: string,
    patch: Partial<Pick<PageDialog, "reload" | "defaultValue">>,
  ): void {
    const guestId = this.byId.get(id);
    if (guestId === undefined) return;
    const entry = this.pages
      .get(guestId)
      ?.queue.find((item) => item.dialog.id === id);
    if (!entry) return;
    entry.dialog = { ...entry.dialog, ...patch };
    this.changed(guestId);
  }

  /**
   * Take back a page's dialogs (all of them, or those `which` picks), as
   * cancelled. Returns how many there were.
   */
  cancel(
    guestId: number,
    which: (dialog: PageDialog, frame: number | null) => boolean = () => true,
  ): number {
    const page = this.pages.get(guestId);
    if (!page) return 0;
    const taken = page.queue.filter((entry) =>
      which(entry.dialog, entry.frame),
    );
    if (taken.length === 0) return 0;
    this.remove(guestId, taken);
    for (const entry of taken) entry.settle(null);
    return taken.length;
  }

  /** Another page loaded in the tab: it starts with dialogs allowed. */
  navigated(guestId: number): void {
    this.cancel(guestId);
    const page = this.pages.get(guestId);
    if (!page) return;
    page.asked = 0;
    page.suppressed = false;
  }

  /** The tab's page is gone: everything it asked is cancelled. */
  forget(guestId: number): void {
    this.cancel(guestId);
    this.pages.delete(guestId);
    this.openListeners.delete(guestId);
  }

  list(guestId: number): PageDialog[] {
    return this.pages.get(guestId)?.queue.map((entry) => entry.dialog) ?? [];
  }

  /** The dialog the page shows now: the first one it asked. */
  current(guestId: number): PageDialog | null {
    return this.pages.get(guestId)?.queue[0]?.dialog ?? null;
  }

  find(guestId: number, kind: PageDialogKind): PageDialog | null {
    return (
      this.pages.get(guestId)?.queue.find((entry) => entry.dialog.kind === kind)
        ?.dialog ?? null
    );
  }

  get(id: string): PageDialog | null {
    const guestId = this.byId.get(id);
    if (guestId === undefined) return null;
    return (
      this.pages.get(guestId)?.queue.find((entry) => entry.dialog.id === id)
        ?.dialog ?? null
    );
  }

  has(guestId: number): boolean {
    return (this.pages.get(guestId)?.queue.length ?? 0) > 0;
  }

  /** Called with each dialog the page opens from now on. Returns the undo. */
  onOpen(guestId: number, listener: (dialog: PageDialog) => void): () => void {
    let listeners = this.openListeners.get(guestId);
    if (!listeners) {
      listeners = new Set();
      this.openListeners.set(guestId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  private page(guestId: number): PageState {
    let page = this.pages.get(guestId);
    if (!page) {
      page = { queue: [], asked: 0, suppressed: false };
      this.pages.set(guestId, page);
    }
    return page;
  }

  private remove(guestId: number, entries: Entry[]): void {
    const page = this.pages.get(guestId);
    if (!page) return;
    page.queue = page.queue.filter((entry) => !entries.includes(entry));
    for (const entry of entries) this.byId.delete(entry.dialog.id);
    this.changed(guestId);
  }

  private changed(guestId: number): void {
    this.publish(guestId, this.list(guestId));
  }
}
