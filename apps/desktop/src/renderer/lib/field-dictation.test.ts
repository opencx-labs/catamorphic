// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { VoiceDictation } from "../../shared/voice.js";
import {
  DICTATION_ATTR,
  DICTATION_PREVIEW_ATTR,
  DICTATION_SETTLING_ATTR,
  DICTATION_WORD_ATTR,
  FieldDictation,
  installFieldDictation,
  SETTLE_MS,
} from "./field-dictation.js";

const words = (
  segment: number,
  text: string,
  final = false,
): VoiceDictation => ({ segment, text, final });

// jsdom has no editing commands: typing falls back to writing the field
// and telling the page, as it does in a field without focus.
beforeAll(() => {
  Object.defineProperty(document, "execCommand", { value: () => false });
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("FieldDictation in an input", () => {
  it("shows the words at the caret as they are said, then types them", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.value = "Draft:";
    input.setSelectionRange(6, 6);
    const typed: string[] = [];
    input.addEventListener("input", () => typed.push(input.value));
    const dictation = new FieldDictation();
    dictation.apply(input, words(1, "ship"));
    expect(input.value).toBe("Draft: ship");
    dictation.apply(input, words(1, "ship it"));
    expect(input.value).toBe("Draft: ship it");
    dictation.apply(input, words(1, "Ship it today.", true));
    expect(input.value).toBe("Draft: Ship it today.");
    expect(input.selectionStart).toBe(input.value.length);
    expect(typed.at(-1)).toBe("Draft: Ship it today.");
    // A later stretch follows the first, a sentence of its own.
    dictation.apply(input, words(2, "Then tell me.", true));
    expect(input.value).toBe("Draft: Ship it today. Then tell me.");
  });

  it("drops a stretch whose words were taken away while showing", () => {
    const input = document.createElement("input");
    document.body.append(input);
    const dictation = new FieldDictation();
    dictation.apply(input, words(1, "send the"));
    // The page cleared the field: its message went.
    input.value = "";
    dictation.apply(input, words(1, "Send the report.", true));
    expect(input.value).toBe("");
    dictation.apply(input, words(2, "Next one.", true));
    expect(input.value).toBe("Next one.");
  });

  it("takes back what showed when the stretch said nothing", () => {
    const area = document.createElement("textarea");
    document.body.append(area);
    area.value = "Keep this";
    area.setSelectionRange(9, 9);
    const dictation = new FieldDictation();
    dictation.apply(area, words(1, "um"));
    expect(area.value).toBe("Keep this um");
    dictation.apply(area, words(1, "", true));
    expect(area.value).toBe("Keep this");
  });
});

describe("FieldDictation in an editor", () => {
  const editor = (preview: boolean) => {
    const root = document.createElement("div");
    root.setAttribute("contenteditable", "true");
    if (preview) root.setAttribute(DICTATION_PREVIEW_ATTR, "");
    root.append("Hello");
    document.body.append(root);
    return root;
  };

  it("shows the words in an editor that asks, then types them in their place", () => {
    vi.useFakeTimers();
    try {
      const root = editor(true);
      const dictation = new FieldDictation();
      dictation.apply(root, words(1, "there"));
      const shown = root.querySelector(`[${DICTATION_ATTR}]`);
      expect(shown?.textContent).toBe(" there");
      expect(root.textContent).toBe("Hello there");
      dictation.apply(root, words(1, "there, friend.", true));
      // Said: the words settle where they showed, then are typed.
      expect(shown?.getAttribute(DICTATION_SETTLING_ATTR)).toBe("said");
      expect(root.textContent).toBe("Hello there, friend.");
      vi.advanceTimersByTime(SETTLE_MS);
      expect(root.querySelector(`[${DICTATION_ATTR}]`)).toBeNull();
      expect(root.textContent).toBe("Hello there, friend.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fades in only the words new to what shows", () => {
    const root = editor(true);
    const dictation = new FieldDictation();
    const spans = () => [
      ...root.querySelectorAll<HTMLElement>(`[${DICTATION_WORD_ATTR}]`),
    ];
    dictation.apply(root, words(1, "send the"));
    const [send, the] = spans();
    dictation.apply(root, words(1, "Send the report"));
    // Firmed up in place (its case), the same spans; one new word.
    expect(spans().slice(0, 2)).toEqual([send, the]);
    expect(spans().map((span) => span.textContent)).toEqual([
      " Send",
      " the",
      " report",
    ]);
    dictation.apply(root, words(1, "Send their report"));
    // A word heard again differently, and what follows it, are new.
    expect(spans()[0]).toBe(send);
    expect(spans()[1]).not.toBe(the);
    expect(root.textContent).toBe("Hello Send their report");
  });

  it("fades out a stretch that said nothing", () => {
    vi.useFakeTimers();
    try {
      const root = editor(true);
      const dictation = new FieldDictation();
      dictation.apply(root, words(1, "um"));
      const shown = root.querySelector(`[${DICTATION_ATTR}]`);
      dictation.apply(root, words(1, "", true));
      expect(shown?.getAttribute(DICTATION_SETTLING_ATTR)).toBe("unsaid");
      // The words that showed fade as they are, then go.
      expect(root.textContent).toBe("Hello um");
      vi.advanceTimersByTime(SETTLE_MS);
      expect(root.textContent).toBe("Hello");
    } finally {
      vi.useRealTimers();
    }
  });

  it("types settling words at once when more come, or the person does", () => {
    vi.useFakeTimers();
    try {
      const root = editor(true);
      const dictation = new FieldDictation();
      dictation.apply(root, words(1, "first"));
      dictation.apply(root, words(1, "first.", true));
      expect(
        root.querySelectorAll(`[${DICTATION_SETTLING_ATTR}]`),
      ).toHaveLength(1);
      dictation.apply(root, words(2, "second"));
      expect(
        root.querySelectorAll(`[${DICTATION_SETTLING_ATTR}]`),
      ).toHaveLength(0);
      expect(root.textContent).toBe("Hello first. second");
      dictation.settle();
      expect(root.querySelector(`[${DICTATION_ATTR}]`)).toBeNull();
      expect(root.textContent).toBe("Hello first. second");
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes nothing for a stretch whose words went with a sent message", () => {
    vi.useFakeTimers();
    try {
      const root = editor(true);
      const dictation = new FieldDictation();
      dictation.apply(root, words(1, "and the"));
      root.replaceChildren();
      dictation.apply(root, words(1, "And the rest.", true));
      expect(root.textContent).toBe("");
      // Sent while settling: nothing comes back either.
      dictation.apply(root, words(2, "Next one."));
      dictation.apply(root, words(2, "Next one.", true));
      root.replaceChildren();
      vi.advanceTimersByTime(SETTLE_MS);
      expect(root.textContent).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives an editor that keeps its own model each stretch once said", () => {
    const root = editor(false);
    const dictation = new FieldDictation();
    dictation.apply(root, words(1, "there"));
    expect(root.textContent).toBe("Hello");
    dictation.apply(root, words(1, "there.", true));
    expect(root.textContent).toBe("Hello there.");
  });
});

describe("installFieldDictation", () => {
  function page() {
    let listener: (words: VoiceDictation) => void = () => {};
    const port = {
      fieldFocused: vi.fn(),
      sent: vi.fn(),
      onWords: (next: (words: VoiceDictation) => void) => {
        listener = next;
        return () => {};
      },
    };
    const uninstall = installFieldDictation(port);
    return { port, say: (next: VoiceDictation) => listener(next), uninstall };
  }

  it("writes into the field the person was last in, and says when it is sent", () => {
    const { port, say, uninstall } = page();
    const form = document.createElement("form");
    const message = document.createElement("input");
    const search = document.createElement("input");
    const button = document.createElement("button");
    form.append(message);
    document.body.append(form, search, button);
    message.focus();
    expect(port.fieldFocused).toHaveBeenCalledTimes(1);
    // A button takes focus; the field is still where the words go.
    button.focus();
    say(words(1, "Lunch at noon.", true));
    expect(message.value).toBe("Lunch at noon.");
    // Return in a field nothing was dictated into sends nothing.
    search.focus();
    search.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(port.sent).not.toHaveBeenCalled();
    message.focus();
    message.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(port.sent).toHaveBeenCalledTimes(1);
    // Shift+Return is a new line, not a send.
    say(words(2, "And dessert.", true));
    message.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(port.sent).toHaveBeenCalledTimes(1);
    form.dispatchEvent(new Event("submit", { bubbles: true }));
    expect(port.sent).toHaveBeenCalledTimes(2);
    uninstall();
  });

  it("writes into the field with focus, though its focus went unheard", () => {
    const composer = document.createElement("textarea");
    document.body.append(composer);
    // Focused before the page listened, as in a window in the background.
    composer.focus();
    const { say, uninstall } = page();
    say(words(1, "Ship it.", true));
    expect(composer.value).toBe("Ship it.");
    uninstall();
  });

  it("ends dictation when a longer text leaves its field on Return, not for a new line", () => {
    vi.useFakeTimers();
    try {
      const { port, say, uninstall } = page();
      const note = document.createElement("textarea");
      document.body.append(note);
      note.focus();
      say(words(1, "First line.", true));
      note.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      vi.advanceTimersByTime(600);
      expect(port.sent).not.toHaveBeenCalled();
      // Command-Return sends a composer: what was in it goes.
      note.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: true,
          bubbles: true,
        }),
      );
      note.value = "";
      vi.advanceTimersByTime(600);
      expect(port.sent).toHaveBeenCalledTimes(1);
      uninstall();
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes where the person was, past a field shut away since", () => {
    const { say, uninstall } = page();
    const composer = document.createElement("textarea");
    const palette = document.createElement("textarea");
    document.body.append(composer, palette);
    composer.focus();
    palette.focus();
    // The palette closes: still there, but inert, and focus goes nowhere.
    palette.setAttribute("inert", "");
    palette.blur();
    say(words(1, "Ship it.", true));
    expect(composer.value).toBe("Ship it.");
    expect(palette.value).toBe("");
    uninstall();
  });

  it("leaves the words showing to the person once they type", () => {
    const { say, uninstall } = page();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    say(words(1, "hello"));
    expect(input.value).toBe("hello");
    // Voice's own keys come by first: they type nothing.
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", altKey: true, bubbles: true }),
    );
    say(words(1, "hello there"));
    expect(input.value).toBe("hello there");
    input.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "insertText",
        data: "x",
        bubbles: true,
      }),
    );
    say(words(1, "Hello there.", true));
    expect(input.value).toBe("hello there");
    uninstall();
  });

  it("writes a stretch once, where it showed, when the person moves on", () => {
    const { say, uninstall } = page();
    const first = document.createElement("input");
    const second = document.createElement("input");
    document.body.append(first, second);
    first.focus();
    say(words(1, "send the"));
    second.focus();
    say(words(1, "Send the report.", true));
    expect(first.value).toBe("send the");
    expect(second.value).toBe("");
    say(words(2, "Thanks.", true));
    expect(second.value).toBe("Thanks.");
    uninstall();
  });

  it("writes nothing while the person is in an editor it cannot write into", () => {
    const { port, say, uninstall } = page();
    const input = document.createElement("input");
    const code = document.createElement("div");
    code.tabIndex = 0;
    Object.defineProperty(code, "editContext", { value: {} });
    document.body.append(input, code);
    input.focus();
    code.focus();
    // The editor says where the person is, so words come here, not elsewhere.
    expect(port.fieldFocused).toHaveBeenCalledTimes(2);
    say(words(1, "const x", true));
    expect(input.value).toBe("");
    uninstall();
  });

  it("types words still settling before the person's key acts", () => {
    vi.useFakeTimers();
    // jsdom has no isContentEditable: the composer is an editor.
    const editable = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "isContentEditable",
    );
    Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
      configurable: true,
      get(this: HTMLElement) {
        return this.closest('[contenteditable="true"]') !== null;
      },
    });
    try {
      const { say, uninstall } = page();
      const composer = document.createElement("div");
      composer.setAttribute("contenteditable", "true");
      composer.setAttribute(DICTATION_PREVIEW_ATTR, "");
      composer.tabIndex = 0;
      document.body.append(composer);
      composer.focus();
      say(words(1, "Thanks"));
      say(words(1, "Thanks.", true));
      expect(composer.querySelector(`[${DICTATION_SETTLING_ATTR}]`)).not.toBe(
        null,
      );
      composer.dispatchEvent(
        new KeyboardEvent("keydown", { key: ",", bubbles: true }),
      );
      expect(composer.querySelector(`[${DICTATION_ATTR}]`)).toBe(null);
      expect(composer.textContent).toBe("Thanks.");
      uninstall();
    } finally {
      if (editable)
        Object.defineProperty(
          HTMLElement.prototype,
          "isContentEditable",
          editable,
        );
      else Reflect.deleteProperty(HTMLElement.prototype, "isContentEditable");
      vi.useRealTimers();
    }
  });

  it("never writes into a password, nor elsewhere while one has focus", () => {
    const { say, uninstall } = page();
    const note = document.createElement("input");
    const password = document.createElement("input");
    password.type = "password";
    document.body.append(note, password);
    note.focus();
    password.focus();
    say(words(1, "secret", true));
    expect(password.value).toBe("");
    expect(note.value).toBe("");
    uninstall();
  });
});
