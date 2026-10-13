// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PageDialog,
  PageDialogAnswer,
} from "../../shared/page-dialogs.js";
import { PageDialogLayer } from "./page-dialog.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const roots: Root[] = [];
afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

const dialog = (overrides: Partial<PageDialog> = {}): PageDialog => ({
  id: "one",
  guestId: 1,
  kind: "confirm",
  origin: "https://example.com",
  embedded: false,
  message: "Sure?",
  defaultValue: "",
  reload: false,
  canSuppress: false,
  ...overrides,
});

function mount(initial: PageDialog[]) {
  const container = document.createElement("div");
  const page = document.createElement("button");
  document.body.append(page, container);
  page.focus();
  const root = createRoot(container);
  roots.push(root);
  const answers: Array<{ answer: PageDialogAnswer; hadFocus: boolean }> = [];
  const pageRef = createRef<HTMLElement>();
  Reflect.set(pageRef, "current", page);
  const render = (dialogs: PageDialog[]) =>
    act(() => {
      root.render(
        <PageDialogLayer
          dialogs={dialogs}
          page={pageRef}
          active
          focusRequest={0}
          onAnswer={(answer, hadFocus) => answers.push({ answer, hadFocus })}
        />,
      );
    });
  render(initial);
  return { container, render, answers, page };
}

const panel = () =>
  document.querySelector<HTMLFormElement>('[data-testid="page-dialog"]');
const byTestId = <T extends HTMLElement>(id: string) =>
  document.querySelector<T>(`[data-testid="${id}"]`);
const key = (target: Element, name: string) =>
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true }),
    );
  });
/**
 * jsdom runs no animations: end one by hand. Without AnimationEvent in
 * jsdom, React listens for the prefixed name.
 */
const endAnimation = (target: Element, name: string) =>
  act(() => {
    for (const type of ["animationend", "webkitAnimationEnd"]) {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, "animationName", { value: name });
      target.dispatchEvent(event);
    }
  });

describe("page dialog layer", () => {
  it("names who asks and shows the page's words as text, taking the page's focus", () => {
    mount([dialog({ message: "<b>Delete</b> it?\nReally?" })]);
    expect(byTestId("page-dialog-title")?.textContent).toBe("example.com says");
    const message = byTestId("page-dialog-message");
    expect(message?.textContent).toBe("<b>Delete</b> it?\nReally?");
    expect(message?.querySelector("b")).toBeNull();
    expect(panel()?.getAttribute("role")).toBe("alertdialog");
    expect(document.activeElement).toBe(byTestId("page-dialog-accept"));
  });

  it("answers Escape with Cancel, and an alert's Escape with OK", () => {
    const { answers, render } = mount([dialog()]);
    key(byTestId("page-dialog-accept") as HTMLElement, "Escape");
    expect(answers.at(-1)).toEqual({
      answer: { id: "one", accept: false },
      hadFocus: true,
    });
    render([dialog({ id: "two", kind: "alert" })]);
    endAnimation(panel() as HTMLElement, "modal-out");
    key(panel() as HTMLElement, "Escape");
    expect(answers.at(-1)?.answer).toEqual({ id: "two", accept: true });
  });

  it("sends a prompt's text, and stops the page's dialogs when asked", () => {
    const { answers } = mount([
      dialog({
        kind: "prompt",
        defaultValue: "Ada",
        canSuppress: true,
      }),
    ]);
    const input = byTestId<HTMLInputElement>("page-dialog-input");
    expect(input?.value).toBe("Ada");
    expect(document.activeElement).toBe(input);
    act(() => {
      byTestId<HTMLInputElement>("page-dialog-suppress")?.click();
    });
    act(() => {
      panel()?.requestSubmit();
    });
    expect(answers.at(-1)?.answer).toEqual({
      id: "one",
      accept: true,
      suppress: true,
      text: "Ada",
    });
  });

  it("shows a queue one at a time, the next once the first has left", () => {
    const { render, answers } = mount([
      dialog({ id: "one", message: "First" }),
      dialog({ id: "two", message: "Second" }),
    ]);
    act(() => {
      byTestId<HTMLButtonElement>("page-dialog-accept")?.click();
    });
    expect(answers).toHaveLength(1);
    render([dialog({ id: "two", message: "Second" })]);
    // The first leaves before the second arrives, and takes no answer.
    expect(panel()?.hasAttribute("inert")).toBe(true);
    expect(byTestId("page-dialog-message")?.textContent).toBe("First");
    act(() => {
      byTestId<HTMLButtonElement>("page-dialog-accept")?.click();
    });
    expect(answers).toHaveLength(1);
    endAnimation(panel() as HTMLElement, "modal-out");
    expect(byTestId("page-dialog-message")?.textContent).toBe("Second");
    expect(panel()?.hasAttribute("inert")).toBe(false);
  });

  it("asks for a sign-in with the site's saved sign-ins, never their secrets", () => {
    const { answers } = mount([
      dialog({
        kind: "auth",
        message: "",
        auth: {
          realm: "Staff",
          scheme: "basic",
          proxy: false,
          insecure: true,
          retry: false,
          username: "",
          saved: [{ id: "saved", username: "ada" }],
        },
      }),
    ]);
    expect(byTestId("page-dialog-title")?.textContent).toBe("Sign in");
    expect(byTestId("page-dialog-origin")?.textContent).toBe("example.com");
    expect(byTestId("page-dialog-realm")?.textContent).toContain("Staff");
    expect(panel()?.textContent).toContain("not private");
    expect(document.activeElement).toBe(byTestId("page-dialog-username"));
    const saved = byTestId("page-dialog-saved")?.querySelector("button");
    act(() => {
      saved?.click();
    });
    expect(answers.at(-1)?.answer).toEqual({
      id: "one",
      accept: true,
      credentialId: "saved",
    });
  });

  it("keeps the keyboard in the dialog after a press on the dim page or its text", () => {
    const { answers, page } = mount([dialog()]);
    const layer = byTestId("page-dialog-layer");
    const dim = layer?.querySelector<HTMLElement>('[aria-hidden="true"]');
    const press = () => {
      const pressed = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        dim?.dispatchEvent(pressed);
      });
      return pressed;
    };
    // Focus in the dialog stays where it is.
    const accept = byTestId("page-dialog-accept");
    expect(document.activeElement).toBe(accept);
    expect(press().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(accept);
    // Focus elsewhere comes to the dialog.
    act(() => page.focus());
    press();
    expect(document.activeElement).toBe(panel());
    // Enter on the dialog itself is OK.
    key(panel() as HTMLElement, "Enter");
    expect(answers.at(-1)?.answer).toEqual({ id: "one", accept: true });
  });

  it("limits what can be typed to what main takes", () => {
    mount([
      dialog({
        kind: "auth",
        message: "",
        embedded: true,
        auth: {
          realm: "",
          scheme: "basic",
          proxy: false,
          insecure: false,
          retry: false,
          username: "",
          saved: [],
        },
      }),
    ]);
    expect(byTestId<HTMLInputElement>("page-dialog-username")?.maxLength).toBe(
      4096,
    );
    expect(byTestId<HTMLInputElement>("page-dialog-password")?.maxLength).toBe(
      4096,
    );
    // Another site's frame asking over this page says so.
    expect(byTestId("page-dialog-embedded")?.textContent).toContain("embedded");
  });

  it("leaves the page's focus alone when the person is elsewhere", () => {
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    elsewhere.focus();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const page = createRef<HTMLElement>();
    act(() => {
      root.render(
        <PageDialogLayer
          dialogs={[dialog()]}
          page={page}
          active
          focusRequest={0}
          onAnswer={vi.fn()}
        />,
      );
    });
    expect(document.activeElement).toBe(elsewhere);
  });
});
