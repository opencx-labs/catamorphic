// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RemoveAgentDialog } from "./remove-agent-dialog.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const roots: Root[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

function mount(onRemove: (agentId: string) => Promise<unknown>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const onClose = vi.fn();
  act(() =>
    root.render(
      <RemoveAgentDialog
        agent={{ id: "a1", name: "Claude" }}
        onClose={onClose}
        onRemove={onRemove}
      />,
    ),
  );
  return { onClose };
}

const confirm = () =>
  document.querySelector<HTMLButtonElement>(
    '[data-testid="remove-agent-confirm"]',
  );

it("says the agent's chats will stop, and removes it once confirmed", async () => {
  const onRemove = vi.fn(async () => true);
  const { onClose } = mount(onRemove);
  expect(document.body.textContent).toContain("Remove Claude?");
  expect(document.body.textContent).toContain("Chats using Claude will stop.");
  await act(async () => confirm()?.click());
  expect(onRemove).toHaveBeenCalledWith("a1");
  expect(onClose).toHaveBeenCalled();
});

it("stays open with the reason when removing fails", async () => {
  const { onClose } = mount(async () => {
    throw new Error("Agent settings could not be saved");
  });
  await act(async () => confirm()?.click());
  expect(document.body.textContent).toContain(
    "Agent settings could not be saved",
  );
  expect(onClose).not.toHaveBeenCalled();
});
