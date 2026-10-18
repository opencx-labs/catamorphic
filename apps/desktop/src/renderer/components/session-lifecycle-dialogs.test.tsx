// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RenameChatDialog } from "./session-lifecycle-dialogs.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const roots: Root[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

function mount(onRename: Parameters<typeof RenameChatDialog>[0]["onRename"]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const onClose = vi.fn();
  act(() =>
    root.render(
      <RenameChatDialog
        chat={{ sessionId: "s1", title: "Plan the offsite" }}
        onClose={onClose}
        onRename={onRename}
      />,
    ),
  );
  return { onClose };
}

/** Type into the field as a person does, so React sees the change. */
function type(field: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const field = () =>
  document.querySelector<HTMLInputElement>('form input[name="title"]');

it("opens with the chat's name and renames it to what was typed", async () => {
  const onRename = vi.fn(async () => {});
  const { onClose } = mount(onRename);
  expect(document.body.textContent).toContain("Rename chat");
  expect(field()?.value).toBe("Plan the offsite");
  const input = field();
  if (!input) throw new Error("No name field");
  type(input, "  Offsite   2027 ");
  await act(async () => input.form?.requestSubmit());
  expect(onRename).toHaveBeenCalledWith({
    sessionId: "s1",
    title: "Offsite 2027",
  });
  expect(onClose).toHaveBeenCalledOnce();
});

it("closes without renaming when the name is unchanged", async () => {
  const onRename = vi.fn(async () => {});
  const { onClose } = mount(onRename);
  const input = field();
  if (!input) throw new Error("No name field");
  await act(async () => input.form?.requestSubmit());
  expect(onRename).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
});

it("refuses an empty name and stays open with why", async () => {
  const onRename = vi.fn(async () => {});
  const { onClose } = mount(onRename);
  const input = field();
  if (!input) throw new Error("No name field");
  type(input, "   ");
  await act(async () => input.form?.requestSubmit());
  expect(onRename).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "Name the chat.",
  );
});
