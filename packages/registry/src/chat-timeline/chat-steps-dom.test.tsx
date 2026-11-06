// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BackgroundStates, type TurnStep, TurnSteps } from "./chat-steps.js";

let box: HTMLDivElement;
let root: Root;
const markdown = vi.fn((text: string) => <p>{text}</p>);
const steps: TurnStep[] = Array.from({ length: 1_000 }, (_, i) => ({
  key: `step-${i}`,
  kind: "note",
  label: `Read document ${i}`,
  detail: `Full document ${i}`,
  markdown: true,
}));
beforeEach(() => {
  vi.useFakeTimers();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  box = document.createElement("div");
  document.body.append(box);
  root = createRoot(box);
  markdown.mockClear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  act(() => root.unmount());
  document.getSelection()?.removeAllRanges();
  box.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});
const render = () =>
  act(async () =>
    root.render(<TurnSteps steps={steps} renderMarkdown={markdown} />),
  );
const toggle = () =>
  box.querySelector<HTMLButtonElement>(
    '[data-testid="chat-turn-steps-toggle"]',
  )!;
const click = (button: HTMLButtonElement) => act(async () => button.click());
const advance = (ms: number) => act(async () => vi.advanceTimersByTime(ms));

it("does not mount folded steps or parse closed payloads, and remembers expanded details", async () => {
  await render();
  expect(box.querySelectorAll('[data-testid="chat-step"]')).toHaveLength(0);
  expect(markdown).not.toHaveBeenCalled();
  await click(toggle());
  expect(box.querySelectorAll('[data-testid="chat-step"]')).toHaveLength(1);
  expect(markdown).not.toHaveBeenCalled();
  await click(
    box.querySelector<HTMLButtonElement>('[data-testid="chat-step"] button')!,
  );
  expect(markdown).toHaveBeenCalledTimes(1);
  expect(box.textContent).toContain("Full document 0");
  await click(toggle());
  expect(
    box.querySelector('[data-testid="chat-step"]')?.closest("[inert]"),
  ).not.toBeNull();
  expect(box.textContent).toContain("Full document 0");
  await advance(250);
  expect(box.querySelectorAll('[data-testid="chat-step"]')).toHaveLength(0);
  await click(toggle());
  expect(box.textContent).toContain("Full document 0");
  expect(markdown).toHaveBeenCalledTimes(2);
});

it("retains the same rows through a late transition and a reversed close", async () => {
  await render();
  await click(toggle());
  const row = box.querySelector('[data-testid="chat-step"]');
  const list = box.querySelector('[data-testid="chat-step-list"]')!;
  let playing = true;
  Object.defineProperty(list, "getAnimations", {
    configurable: true,
    value: () =>
      playing
        ? [{ transitionProperty: "grid-template-rows", playState: "running" }]
        : [],
  });
  await click(toggle());
  await advance(500);
  expect(box.querySelector('[data-testid="chat-step"]')).toBe(row);
  await click(toggle());
  await advance(500);
  expect(box.querySelector('[data-testid="chat-step"]')).toBe(row);
  await click(toggle());
  playing = false;
  await advance(250);
  expect(box.querySelector('[data-testid="chat-step"]')).toBeNull();
});

it.each([true, false])(
  "retains a completed watch once through its inert height collapse (fold=%s)",
  async (fold) => {
    const watch: TurnStep = {
      key: "watch",
      kind: "background",
      label: "Wait for checks",
      background: {
        kind: "watch",
        ref: "checks",
        description: "Wait for checks",
      },
    };
    const show = (running: boolean) =>
      act(async () =>
        root.render(
          <BackgroundStates.Provider
            value={
              new Map([
                [
                  "checks",
                  {
                    kind: "watch",
                    command: "true",
                    description: "Wait for checks",
                    status: running ? "running" : "finished",
                    exitCode: running ? null : 0,
                  },
                ],
              ])
            }
          >
            <TurnSteps
              steps={[watch]}
              live={!fold}
              fold={fold}
              renderMarkdown={markdown}
            />
          </BackgroundStates.Provider>,
        ),
      );
    await show(true);
    const row = box.querySelector('[data-testid="chat-background-presence"]');
    expect(row).not.toBeNull();
    await show(false);
    expect(row?.hasAttribute("data-closed")).toBe(true);
    expect(row?.hasAttribute("inert")).toBe(true);
    expect(row?.textContent).toContain("Wait for checks");
    expect(box.querySelectorAll('[data-testid="chat-step"]')).toHaveLength(1);
    await advance(250);
    expect(row?.isConnected).toBe(false);
    expect(box.querySelectorAll('[data-testid="chat-step"]')).toHaveLength(
      fold ? 0 : 1,
    );
  },
);

it("keeps a focused detail closed when its list is folded and reopened", async () => {
  const focused = steps.map((step, index) =>
    index === 0 ? { ...step, focused: true } : step,
  );
  await act(async () =>
    root.render(
      <TurnSteps steps={focused} renderMarkdown={markdown} defaultExpanded />,
    ),
  );
  expect(box.textContent).toContain("Full document 0");
  await click(
    box.querySelector<HTMLButtonElement>('[data-testid="chat-step"] button')!,
  );
  await advance(250);
  expect(box.querySelector('[data-testid="chat-step-detail"]')).toBeNull();
  await click(toggle());
  await advance(250);
  await click(toggle());
  expect(box.querySelector('[data-testid="chat-step-detail"]')).toBeNull();
});

it("windows a long log without replacing focused rows when earlier work arrives", async () => {
  let scroll = 0;
  const rect = (top: number, height: number) => ({
    top,
    bottom: top + height,
    left: 0,
    right: 500,
    width: 500,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  });
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(
    () => [rect(0, 400)] as unknown as DOMRectList,
  );
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      return rect(
        this.getAttribute("data-testid") === "chat-step-window" ? -scroll : 0,
        this.hasAttribute("data-step-key") ? 28 : 400,
      ) as DOMRect;
    },
  );
  const show = (items = steps) =>
    act(async () =>
      root.render(
        <TurnSteps steps={items} renderMarkdown={markdown} defaultExpanded />,
      ),
    );
  await show();
  expect(box.querySelectorAll("[data-step-key]").length).toBeLessThan(100);
  const button = box.querySelector<HTMLButtonElement>(
    '[data-step-key="step-1"] button',
  )!;
  await act(async () => button.focus());
  scroll = 12_000;
  await act(async () => window.dispatchEvent(new Event("scroll")));
  await advance(32);
  expect(button.isConnected).toBe(true);
  expect(document.activeElement).toBe(button);
  expect(box.querySelectorAll("[data-step-key]").length).toBeLessThan(160);
  expect(box.querySelector('[data-step-key="step-440"]')).not.toBeNull();
  await show([
    { ...steps[0]!, key: "earlier", label: "Earlier folded note" },
    ...steps,
  ]);
  expect(box.querySelector('[data-step-key="step-1"] button')).toBe(button);
  expect(document.activeElement).toBe(button);
});

it("materializes a distant notification target and retains its chosen detail", async () => {
  await act(async () =>
    root.render(
      <TurnSteps
        steps={steps.map((step, index) =>
          index === 750 ? { ...step, focused: true } : step,
        )}
        renderMarkdown={markdown}
        defaultExpanded
      />,
    ),
  );
  expect(
    box.querySelector('[data-step-key="step-750"]')?.textContent,
  ).toContain("Full document 750");
  expect(box.querySelectorAll("[data-step-key]").length).toBeLessThan(5);
});

it("animates completed background work joining an already expanded list", async () => {
  const watch: TurnStep = {
    key: "watch-arrival",
    kind: "background",
    label: "Wait for checks",
    background: {
      kind: "watch",
      ref: "arrival",
      description: "Wait for checks",
    },
  };
  const show = (running: boolean) =>
    act(async () =>
      root.render(
        <BackgroundStates.Provider
          value={
            new Map([
              [
                "arrival",
                {
                  kind: "watch",
                  command: "true",
                  description: "Wait for checks",
                  status: running ? "running" : "finished",
                  exitCode: running ? null : 0,
                },
              ],
            ])
          }
        >
          <TurnSteps
            steps={[steps[0]!, watch]}
            live
            renderMarkdown={markdown}
          />
        </BackgroundStates.Provider>,
      ),
    );
  await show(true);
  await show(false);
  await advance(250);
  expect(
    box
      .querySelector('[data-step-key="watch-arrival"]')
      ?.classList.contains("cat-step-in"),
  ).toBe(true);
});

it("keeps focus when live history crosses the windowing threshold", async () => {
  const show = (count: number) =>
    act(async () =>
      root.render(
        <TurnSteps
          steps={steps.slice(0, count)}
          live
          renderMarkdown={markdown}
        />,
      ),
    );
  await show(96);
  const button = box.querySelector<HTMLButtonElement>(
    '[data-step-key="step-1"] button',
  )!;
  await act(async () => button.focus());
  await show(97);
  expect(button.isConnected).toBe(true);
  expect(document.activeElement).toBe(button);
});

it("keeps small historical groups free of global interaction subscriptions", async () => {
  const subscribe = vi.spyOn(document, "addEventListener");
  await act(async () =>
    root.render(
      steps
        .slice(0, 100)
        .map((step) => (
          <TurnSteps key={step.key} steps={[step]} renderMarkdown={markdown} />
        )),
    ),
  );
  expect(
    subscribe.mock.calls.filter(([type]) =>
      ["focusin", "focusout", "selectionchange"].includes(type),
    ),
  ).toHaveLength(0);
});

it("keeps an existing multi-row selection when windowing first activates", async () => {
  const show = (count: number) =>
    act(async () =>
      root.render(
        <TurnSteps
          steps={steps.slice(0, count)}
          live
          renderMarkdown={markdown}
        />,
      ),
    );
  await show(96);
  const selected = [92, 93, 94].map(
    (index) => box.querySelector(`[data-step-key="step-${index}"]`)!,
  );
  const range = document.createRange();
  range.setStartBefore(selected[0]!);
  range.setEndAfter(selected[2]!);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const text = selection.toString();
  expect(text).toContain("Read document 93");
  await show(97);
  expect(selected.every((row) => row.isConnected)).toBe(true);
  expect(selection.toString()).toBe(text);
  await act(async () => {
    selection.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  });
  expect(selected.every((row) => !row.isConnected)).toBe(true);
});

it("retains a pressed row across the threshold and releases it on pointer up", async () => {
  const show = (count: number) =>
    act(async () =>
      root.render(
        <TurnSteps
          steps={steps.slice(0, count)}
          live
          renderMarkdown={markdown}
        />,
      ),
    );
  await show(96);
  const row = box.querySelector('[data-step-key="step-1"]')!;
  await act(async () =>
    row.dispatchEvent(new Event("pointerdown", { bubbles: true })),
  );
  await show(97);
  expect(row.isConnected).toBe(true);
  await act(async () => window.dispatchEvent(new Event("pointerup")));
  expect(row.isConnected).toBe(false);
});
