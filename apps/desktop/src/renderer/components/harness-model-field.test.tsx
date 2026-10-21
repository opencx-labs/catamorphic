// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "../lib/desktop-api.js";
import { HarnessModelField } from "./harness-model-field.js";

vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: { agentModels: vi.fn() },
}));

const codex = { id: "codex-1", harness: "codex" as const };

describe("HarnessModelField", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.resetAllMocks();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  const render = async (value: string, onChange = vi.fn()) => {
    await act(async () =>
      root.render(
        <HarnessModelField
          agent={codex}
          value={value}
          onChange={onChange}
          hint="Default uses the harness default."
        />,
      ),
    );
    return onChange;
  };
  const select = () =>
    container.querySelector<HTMLSelectElement>("[data-testid=agent-model]");
  const input = () =>
    container.querySelector<HTMLInputElement>(
      "[data-testid=agent-model-input]",
    );

  it("lists the harness's models after its default, and picks one", async () => {
    vi.mocked(desktopApi.agentModels).mockResolvedValue({
      models: [
        { id: "gpt-5.5", name: "GPT-5.5 Thinking" },
        { id: "gpt-5.5-mini" },
      ],
    });
    const onChange = await render("");
    expect(desktopApi.agentModels).toHaveBeenCalledWith("codex-1");
    expect([...(select()?.options ?? [])].map((o) => o.textContent)).toEqual([
      "Codex default",
      "GPT-5.5 Thinking (gpt-5.5)",
      "gpt-5.5-mini",
      "Other model…",
    ]);
    expect(input()).toBeNull();
    await act(async () => {
      const element = select();
      if (!element) return;
      element.value = "gpt-5.5";
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("gpt-5.5");
  });

  it("offers no default to a built-in agent, which needs a model", async () => {
    vi.mocked(desktopApi.agentModels).mockResolvedValue({
      models: [{ id: "claude-sonnet-5" }],
    });
    await act(async () =>
      root.render(
        <HarnessModelField
          agent={{ id: "builtin-1", harness: "ai-sdk", provider: "anthropic" }}
          value=""
          onChange={vi.fn()}
          hint="Any model id your API key can access."
        />,
      ),
    );
    const options = [...(select()?.options ?? [])];
    expect(options.map((o) => o.textContent)).toEqual([
      "Choose a model",
      "claude-sonnet-5",
      "Other model…",
    ]);
    expect(options[0]?.disabled).toBe(true);
  });

  it("keeps a model the catalog does not list as typed", async () => {
    vi.mocked(desktopApi.agentModels).mockResolvedValue({
      models: [{ id: "gpt-5.5" }],
    });
    await render("my-fine-tune");
    expect(select()?.value).toBe("\0other");
    expect(input()?.value).toBe("my-fine-tune");
  });

  it("falls back to the plain field without a catalog", async () => {
    vi.mocked(desktopApi.agentModels).mockResolvedValue({
      models: [],
      error: "Could not load models.",
    });
    await render("");
    expect(select()).toBeNull();
    expect(input()).not.toBeNull();
    expect(container.textContent).toContain("Could not load models.");
  });
});
