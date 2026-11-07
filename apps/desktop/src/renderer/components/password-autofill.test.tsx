// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appIsMovingFocus } from "../lib/app-focus.js";
import { desktopApi } from "../lib/desktop-api.js";
import {
  type AutofillGuest,
  usePasswordAutofill,
} from "./password-autofill.js";

vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    browserPasswordSuggest: vi.fn(async () => ({
      password: "generated-secret",
    })),
    browserPasswordUseSuggested: vi.fn(async () => true),
  },
}));

const roots: Root[] = [];
const listSelector = '[data-testid="password-suggestions"]';

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.useRealTimers();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
});

function mount() {
  const page = document.createElement("button");
  const container = document.createElement("div");
  document.body.append(page, container);
  // jsdom has no layout. The visibility boundary remains controlled by the DOM.
  Object.defineProperty(container, "checkVisibility", {
    value: () => !container.hidden,
  });
  let url = "https://example.test/signup";
  const focusStates: Array<{ listPresent: boolean; appMove: boolean }> = [];
  const guest = {
    focus: vi.fn(() => {
      focusStates.push({
        listPresent: container.querySelector(listSelector) !== null,
        appMove: appIsMovingFocus(),
      });
      page.focus();
    }),
    getURL: () => url,
    getWebContentsId: () => 17,
    send: vi.fn(),
  } satisfies AutofillGuest;
  const guestRef = createRef<AutofillGuest>();
  guestRef.current = guest;
  const containerRef = createRef<HTMLElement>();
  containerRef.current = container;
  let handleGuestMessage: ReturnType<
    typeof usePasswordAutofill
  >["handleGuestMessage"] = () => false;
  function Harness() {
    const autofill = usePasswordAutofill({
      profileId: "profile-1",
      guestRef,
      containerRef,
      faviconUrl: null,
    });
    handleGuestMessage = autofill.handleGuestMessage;
    return autofill.overlay;
  }
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<Harness />));

  const show = async () => {
    await act(async () => {
      handleGuestMessage("catamorphic:autofill-show", [
        {
          fieldId: "password-field",
          kind: "new-password",
          rect: { x: 20, y: 20, width: 300, height: 32 },
          value: "",
        },
      ]);
    });
    expect(
      container.querySelector(listSelector)?.getAttribute("data-open"),
    ).toBe("true");
  };
  const list = () => {
    const element = container.querySelector<HTMLElement>(listSelector);
    if (!element) throw new Error("Password suggestions did not render");
    return element;
  };
  const pick = () => {
    const row = container.querySelector<HTMLElement>(
      '[data-testid="password-suggestion-generated"]',
    );
    if (!row) throw new Error("Generated password did not render");
    act(() => row.click());
    expect(list().getAttribute("data-open")).toBe("false");
    // Reproduce the native press's late blur, after the immediate focus call
    // but while the shell's closing overlay is still mounted.
    page.blur();
  };
  const finishExit = () => {
    const element = list();
    act(() => {
      // React/jsdom may use either animation event spelling.
      for (const type of ["animationend", "webkitAnimationEnd"]) {
        const event = new Event(type, { bubbles: true });
        Object.defineProperty(event, "animationName", { value: "pop-out" });
        element.dispatchEvent(event);
      }
    });
    expect(container.querySelector(listSelector)).toBeNull();
  };
  return {
    page,
    container,
    guest,
    guestRef,
    focusStates,
    show,
    pick,
    finishExit,
    navigate: (next: string) => {
      url = next;
    },
    rerender: () => act(() => root.render(<Harness />)),
    blur: () =>
      act(() => {
        handleGuestMessage("catamorphic:autofill-hide", [{ reason: "blur" }]);
      }),
  };
}

describe("password autofill focus handoff", () => {
  it("leaves an app-focused control inside the browser in charge", async () => {
    const fixture = mount();
    await fixture.show();
    fixture.pick();
    const findInput = document.createElement("input");
    fixture.container.append(findInput);
    findInput.focus();
    fixture.finishExit();
    expect(document.activeElement).toBe(findInput);
    expect(fixture.guest.focus).toHaveBeenCalledTimes(1);
  });

  it("leaves focus in a dialog opened before the picked list finishes closing", async () => {
    const fixture = mount();
    await fixture.show();
    fixture.pick();
    // The next action can open its dialog without another key or press.
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const choice = document.createElement("button");
    dialog.append(choice);
    document.body.append(dialog);
    choice.focus();
    fixture.finishExit();
    expect(document.activeElement).toBe(choice);
    expect(fixture.guest.focus).toHaveBeenCalledTimes(1);
  });

  it("restores the page once after the picked list has actually left the DOM", async () => {
    const fixture = mount();
    await fixture.show();
    fixture.pick();
    expect(
      desktopApi.browserPasswordUseSuggested,
    ).toHaveBeenCalledExactlyOnceWith({
      profileId: "profile-1",
      guestId: 17,
      fieldId: "password-field",
    });
    expect(fixture.guest.focus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(document.body);
    fixture.finishExit();
    expect(document.activeElement).toBe(fixture.page);
    expect(fixture.focusStates).toEqual([
      { listPresent: true, appMove: false },
      { listPresent: false, appMove: true },
    ]);
    fixture.rerender();
    expect(fixture.guest.focus).toHaveBeenCalledTimes(2);
  });

  it("does not restore an old guest after the page has been replaced", async () => {
    const fixture = mount();
    await fixture.show();
    fixture.pick();
    const replacementFocus = vi.fn();
    fixture.guestRef.current = { ...fixture.guest, focus: replacementFocus };
    fixture.finishExit();
    expect(fixture.guest.focus).toHaveBeenCalledTimes(1);
    expect(replacementFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it("does not focus a new URL even within the original site's origin", async () => {
    const fixture = mount();
    await fixture.show();
    fixture.pick();
    fixture.navigate("https://example.test/signup?step=next");
    fixture.finishExit();
    expect(fixture.guest.focus).toHaveBeenCalledTimes(1);
  });

  it.each(["hidden", "inert"])(
    "does not focus a page whose container became %s",
    async (state) => {
      const fixture = mount();
      await fixture.show();
      fixture.pick();
      if (state === "hidden") fixture.container.hidden = true;
      else fixture.container.setAttribute("inert", "");
      fixture.finishExit();
      expect(fixture.guest.focus).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(document.body);
    },
  );

  it("leaves focus where the person put it after picking the password", async () => {
    const fixture = mount();
    await fixture.show();
    fixture.pick();
    const other = document.createElement("input");
    document.body.append(other);
    other.focus();
    other.dispatchEvent(
      new KeyboardEvent("keydown", { key: "x", bubbles: true }),
    );
    fixture.finishExit();
    expect(fixture.guest.focus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(other);
  });

  it("never restores focus for a list closed only by the field's blur", async () => {
    vi.useFakeTimers();
    const fixture = mount();
    await fixture.show();
    fixture.blur();
    act(() => vi.advanceTimersByTime(250));
    fixture.finishExit();
    expect(fixture.guest.focus).not.toHaveBeenCalled();
    expect(fixture.focusStates).toEqual([]);
  });
});
