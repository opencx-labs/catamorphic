// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { SidebarActionInput } from "../../shared/sidebar.js";
import {
  ActionInputDialog,
  dateTimeInstant,
  localDateTime,
} from "./action-input-dialog.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let root: Root;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});
function mount(input: SidebarActionInput, run = vi.fn(async () => {})) {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  const close = vi.fn();
  act(() =>
    root.render(
      <ActionInputDialog
        request={{ label: "Add task", input, run }}
        onClose={close}
      />,
    ),
  );
  return { run, close };
}
function control(name: string) {
  const el = document.querySelector<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >(`[name="${name}"]`);
  if (!el) throw Error(`Missing ${name}`);
  return el;
}
function fill(name: string, value: string) {
  const el = control(name);
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}
const button = (name: string) => {
  const el = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === name,
  );
  if (!el) throw Error(`No ${name}`);
  return el;
};
it("submits presets and a second custom reminder as typed values, preserving the first entry", async () => {
  const { run, close } = mount({
    fields: [
      { name: "title", label: "Title", required: true },
      {
        name: "reminders",
        label: "Reminders",
        type: "repeat",
        minItems: 1,
        maxItems: 3,
        addLabel: "Add reminder",
        fields: [
          {
            name: "preset",
            label: "Remind me",
            type: "select",
            options: [
              { label: "2 days", value: "2d" },
              { label: "One week", value: "1w" },
              { label: "Custom", value: "custom" },
            ],
          },
          {
            name: "amount",
            label: "Hours",
            type: "number",
            required: true,
            min: 1,
            when: { field: "preset", equals: "custom" },
          },
        ],
      },
    ],
  });
  fill("title", "Read proposal");
  const first = control("reminders.0.preset");
  expect(
    control("reminders.0.amount").closest("fieldset[disabled]"),
  ).not.toBeNull();
  act(() => button("Add reminder").click());
  expect(control("reminders.0.preset")).toBe(first);
  fill("reminders.1.preset", "custom");
  fill("reminders.1.amount", "3");
  await act(async () => document.querySelector("form")?.requestSubmit());
  expect(run).toHaveBeenCalledWith({
    title: "Read proposal",
    reminders: [{ preset: "2d" }, { preset: "custom", amount: 3 }],
  });
  expect(close).toHaveBeenCalledOnce();
});

it("skips retained hidden controls when focusing and wrapping Tab", () => {
  mount({
    fields: [
      {
        name: "hidden",
        label: "Hidden",
        required: true,
        when: { field: "show", equals: "yes" },
      },
      { name: "show", label: "Show", value: "no" },
    ],
  });
  expect(document.activeElement).toBe(control("show"));
  expect(control("hidden").matches(":disabled")).toBe(true);
  act(() => button("Save").focus());
  act(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(document.activeElement).toBe(control("show"));
  act(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(document.activeElement).toBe(button("Save"));
});
it("keeps edited values and the dialog on action failure; supports checkbox, prose and an absolute local datetime", async () => {
  const instant = "2027-02-05T12:00:00.000Z";
  const { run, close } = mount(
    {
      fields: [
        { name: "notes", label: "Notes", type: "textarea", value: "Details" },
        { name: "enabled", label: "Enabled", type: "checkbox", value: true },
        { name: "at", label: "At", type: "datetime", value: instant },
      ],
    },
    vi.fn(async () => {
      throw Error("Could not save");
    }),
  );
  expect(control("at").value).toBe(localDateTime(instant));
  fill("notes", "Changed");
  await act(async () => document.querySelector("form")?.requestSubmit());
  expect(run).toHaveBeenCalledWith({
    notes: "Changed",
    enabled: true,
    at: instant,
  });
  expect(close).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not save",
  );
  expect(control("notes").value).toBe("Changed");
});
it("rejects impossible local times rather than silently normalizing them", () => {
  expect(() => dateTimeInstant("2027-02-30T12:00")).toThrow("does not exist");
});

it("preserves seconds and milliseconds in existing datetime values", async () => {
  const at = "2027-02-05T12:00:15.250Z";
  const { run } = mount({
    fields: [{ name: "at", label: "At", type: "datetime", value: at }],
  });
  await act(async () => document.querySelector("form")?.requestSubmit());
  expect(run).toHaveBeenCalledWith({ at });
});

it("keeps one inline request through parent updates and closes that request after saving", async () => {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  let finish: () => void = () => {};
  const close = vi.fn();
  const run = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const render = () =>
    root.render(
      <ActionInputDialog
        requestKey="rename-chat"
        request={{
          label: "Rename",
          input: {
            fields: [{ name: "title", label: "Title", value: "Before" }],
          },
          run,
        }}
        onClose={close}
      />,
    );
  act(render);
  fill("title", "After");
  const field = control("title");
  act(() => document.querySelector("form")?.requestSubmit());
  act(render);
  expect(control("title")).toBe(field);
  expect(control("title").value).toBe("After");
  await act(async () => finish());
  expect(close).toHaveBeenCalledOnce();
});

it("ignores a saved request's late completion after a different request opens", async () => {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  let finish: () => void = () => {};
  const close = vi.fn();
  const first = {
    label: "First",
    input: { fields: [{ name: "title", label: "Title" }] },
    run: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  };
  act(() => root.render(<ActionInputDialog request={first} onClose={close} />));
  act(() => document.querySelector("form")?.requestSubmit());
  act(() => root.render(<ActionInputDialog request={null} onClose={close} />));
  const next = {
    label: "Next",
    input: { fields: [{ name: "title", label: "Title", value: "Next" }] },
    run: async () => {},
  };
  act(() => root.render(<ActionInputDialog request={next} onClose={close} />));
  await act(async () => finish());
  expect(control("title").value).toBe("Next");
  expect(close).not.toHaveBeenCalled();
});
