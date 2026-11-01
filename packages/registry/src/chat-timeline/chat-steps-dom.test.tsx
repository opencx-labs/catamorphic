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
});
afterEach(() => {
  act(() => root.unmount());
  box.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
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
  expect(box.querySelectorAll('[data-testid="chat-step"]')).toHaveLength(1_000);
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
  const list = row!.parentElement!.parentElement!.parentElement!;
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
