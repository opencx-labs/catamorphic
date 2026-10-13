import { describe, expect, it, vi } from "vitest";
import type { PageDialog } from "../shared/page-dialogs.js";
import {
  PAGE_DIALOG_QUEUE_LIMIT,
  type PageDialogRequest,
  PageDialogs,
} from "./page-dialogs.js";

const request = (
  guestId: number,
  overrides: Partial<PageDialogRequest> = {},
): PageDialogRequest => ({
  guestId,
  kind: "alert",
  origin: "https://example.com",
  embedded: false,
  message: "Hello",
  defaultValue: "",
  reload: false,
  ...overrides,
});

const setup = () => {
  const published: Array<{ guestId: number; dialogs: PageDialog[] }> = [];
  const dialogs = new PageDialogs((guestId, list) =>
    published.push({ guestId, dialogs: list }),
  );
  return { dialogs, published };
};

describe("page dialogs", () => {
  it("queues a page's dialogs and shows the first it asked", async () => {
    const { dialogs, published } = setup();
    const first = dialogs.ask(request(1, { message: "one" }));
    const second = dialogs.ask(request(1, { kind: "confirm", message: "two" }));
    expect(dialogs.current(1)?.message).toBe("one");
    expect(dialogs.list(1).map((dialog) => dialog.message)).toEqual([
      "one",
      "two",
    ]);
    expect(published.at(-1)?.dialogs).toHaveLength(2);

    const shown = dialogs.current(1);
    expect(dialogs.answer({ id: shown?.id ?? "", accept: true })).toEqual(
      shown,
    );
    await expect(first).resolves.toMatchObject({ accept: true });
    expect(dialogs.current(1)?.message).toBe("two");
    const next = dialogs.current(1);
    dialogs.answer({ id: next?.id ?? "", accept: false });
    await expect(second).resolves.toMatchObject({ accept: false });
    expect(dialogs.has(1)).toBe(false);
    expect(published.at(-1)).toEqual({ guestId: 1, dialogs: [] });
  });

  it("keeps each tab's dialogs to its own page", () => {
    const { dialogs } = setup();
    void dialogs.ask(request(1, { message: "first tab" }));
    void dialogs.ask(request(2, { message: "second tab" }));
    expect(dialogs.current(1)?.message).toBe("first tab");
    expect(dialogs.current(2)?.message).toBe("second tab");
    dialogs.forget(1);
    expect(dialogs.has(1)).toBe(false);
    expect(dialogs.current(2)?.message).toBe("second tab");
  });

  it("answers a dialog only once", () => {
    const { dialogs } = setup();
    void dialogs.ask(request(1));
    const id = dialogs.current(1)?.id ?? "";
    expect(dialogs.answer({ id, accept: true })).not.toBeNull();
    expect(dialogs.answer({ id, accept: false })).toBeNull();
    expect(dialogs.answer({ id: "unknown", accept: true })).toBeNull();
  });

  it("offers to stop a page's dialogs from its second one, until another page loads", async () => {
    const { dialogs } = setup();
    void dialogs.ask(request(1, { message: "one" }));
    expect(dialogs.current(1)?.canSuppress).toBe(false);
    dialogs.answer({ id: dialogs.current(1)?.id ?? "", accept: true });
    void dialogs.ask(request(1, { kind: "prompt", message: "two" }));
    expect(dialogs.current(1)?.canSuppress).toBe(true);
    dialogs.answer({
      id: dialogs.current(1)?.id ?? "",
      accept: true,
      text: "x",
      suppress: true,
    });
    // Suppressed: the page's script dialogs come back unanswered at once.
    await expect(dialogs.ask(request(1, { kind: "confirm" }))).resolves.toBe(
      null,
    );
    expect(dialogs.has(1)).toBe(false);
    // A sign-in is not the page's script: it still asks.
    void dialogs.ask(request(1, { kind: "auth" }));
    expect(dialogs.current(1)?.kind).toBe("auth");
    expect(dialogs.current(1)?.canSuppress).toBe(false);

    dialogs.navigated(1);
    expect(dialogs.has(1)).toBe(false);
    void dialogs.ask(request(1, { message: "next page" }));
    expect(dialogs.current(1)?.message).toBe("next page");
    expect(dialogs.current(1)?.canSuppress).toBe(false);
  });

  it("cancels what a navigation or a closed tab takes back", async () => {
    const { dialogs } = setup();
    const top = dialogs.ask(request(1, { message: "top" }), { frame: 10 });
    const frame = dialogs.ask(
      request(1, { message: "frame", embedded: true }),
      { frame: 11 },
    );
    // The embedded frame navigated: only its own question goes.
    expect(dialogs.cancel(1, (_dialog, asker) => asker === 11)).toBe(1);
    await expect(frame).resolves.toBeNull();
    expect(dialogs.current(1)?.message).toBe("top");
    dialogs.forget(1);
    await expect(top).resolves.toBeNull();
  });

  it("tells listeners when a page opens a dialog", () => {
    const { dialogs } = setup();
    const opened = vi.fn();
    const stop = dialogs.onOpen(1, opened);
    void dialogs.ask(request(2));
    expect(opened).not.toHaveBeenCalled();
    void dialogs.ask(request(1, { kind: "confirm" }));
    expect(opened).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "confirm" }),
    );
    stop();
    void dialogs.ask(request(1));
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("cancels what a page asks beyond its queue's limit", async () => {
    const { dialogs } = setup();
    for (let index = 0; index < PAGE_DIALOG_QUEUE_LIMIT; index++)
      void dialogs.ask(request(1, { kind: "auth", message: `${index}` }));
    await expect(dialogs.ask(request(1, { kind: "auth" }))).resolves.toBeNull();
    expect(dialogs.list(1)).toHaveLength(PAGE_DIALOG_QUEUE_LIMIT);
  });

  it("changes an open Leave site? in place", () => {
    const { dialogs, published } = setup();
    void dialogs.ask(request(1, { kind: "beforeunload", message: "" }));
    const open = dialogs.find(1, "beforeunload");
    dialogs.update(open?.id ?? "", { reload: true });
    expect(dialogs.current(1)).toMatchObject({ id: open?.id, reload: true });
    expect(published.at(-1)?.dialogs[0]?.reload).toBe(true);
  });
});
