// @vitest-environment jsdom

import type { AgentQuestion } from "@catamorphic/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentQuestionPanel } from "./agent-question-panel.js";

const questions: AgentQuestion[] = [
  {
    question: "What is your favorite color?",
    header: "Color",
    multiSelect: false,
    options: [
      { label: "Orange", description: "Warm." },
      { label: "Blue", description: "Calm." },
    ],
  },
  {
    question: "Cats or dogs?",
    header: "Pets",
    multiSelect: false,
    options: [
      { label: "Cats", description: "Independent." },
      { label: "Dogs", description: "Loyal." },
    ],
  },
];

describe("AgentQuestionPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    // jsdom draws no layout: the panel's height follows nothing.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  const option = (label: string) => {
    const button = [...container.querySelectorAll("button")].find((element) =>
      element.textContent?.startsWith(label),
    );
    if (!button) throw new Error(`No ${label} option`);
    return button;
  };

  it("moves focus to the next question's first option as that question becomes active", async () => {
    // A frame can come before React draws the change, when the next
    // question is still inert and takes no focus: focusing then left focus
    // nowhere. The move must not wait on a frame at all.
    vi.stubGlobal("requestAnimationFrame", () => 0);
    await act(async () =>
      root.render(
        <AgentQuestionPanel
          questions={questions}
          onSubmit={() => undefined}
          onDismiss={() => undefined}
        />,
      ),
    );
    const orange = option("Orange");
    orange.focus();
    await act(async () => orange.click());
    // Single-select answers glide to the next unanswered question.
    await act(async () => vi.advanceTimersByTime(300));
    const cats = option("Cats");
    expect(cats.closest("[inert]")).toBeNull();
    expect(document.activeElement).toBe(cats);
  });
});
