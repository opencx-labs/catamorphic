import { expect, it } from "vitest";
import { PaletteHistory, type PaletteSnapshot } from "./history.js";

const snapshot = (
  message: string,
  mode: string | null = null,
): PaletteSnapshot => ({
  mode,
  draft: { message, attachments: [] },
  selection: { anchor: message.length, focus: message.length },
});
it("orders modes with repeated identical text and branches redo after a new edit", () => {
  const history = new PaletteHistory();
  const mode = snapshot("", "agent");
  history.record({ before: snapshot("agent"), after: mode, kind: "mode" });
  history.record({
    before: mode,
    after: snapshot("hello", "agent"),
    kind: "insertText",
  });
  history.record({
    before: snapshot("hello", "agent"),
    after: mode,
    kind: "deleteContentBackward",
  });
  history.record({
    before: mode,
    after: snapshot("other", "agent"),
    kind: "insertText",
  });
  expect(history.undo()).toEqual(mode);
  expect(history.undo()).toEqual(snapshot("hello", "agent"));
  expect(history.redo()).toEqual(mode);
  expect(history.undo()).toEqual(snapshot("hello", "agent"));
  history.record({
    before: snapshot("hello", "agent"),
    after: snapshot("new", "agent"),
    kind: "insertFromPaste",
  });
  expect(history.redo()).toBeUndefined();
});
it("groups continuous typing and separates selection replacements and mode changes", () => {
  const history = new PaletteHistory();
  history.record({
    before: snapshot(""),
    after: snapshot("a"),
    kind: "insertText",
    time: 0,
  });
  history.record({
    before: snapshot("a"),
    after: snapshot("ab"),
    kind: "insertText",
    time: 100,
  });
  expect(history.undo()).toEqual(snapshot(""));
  expect(history.redo()).toEqual(snapshot("ab"));
  history.record({
    before: { ...snapshot("ab"), selection: { anchor: 0, focus: 1 } },
    after: snapshot("xb"),
    kind: "insertText",
    time: 200,
  });
  expect(history.undo()?.draft.message).toBe("ab");
  history.record({
    before: snapshot("ab"),
    after: snapshot("", "web"),
    kind: "mode",
    time: 300,
  });
  expect(history.undo()).toEqual(snapshot("ab"));
});
it("treats composition, attachments and Backspace mode exit as distinct edits", () => {
  const history = new PaletteHistory();
  const mode = snapshot("", "agent");
  const composed = snapshot("日本語", "agent");
  history.record({ before: mode, after: composed, kind: "composition" });
  expect(history.undo()).toEqual(mode);
  expect(history.redo()).toEqual(composed);
  const attachment: PaletteSnapshot = {
    ...mode,
    draft: {
      message: "\uFFFC",
      attachments: [
        {
          kind: "text",
          name: "Clipboard",
          text: "Selected prose",
          source: { type: "paste" },
        },
      ],
    },
  };
  history.record({ before: composed, after: attachment, kind: "change" });
  expect(history.undo()).toEqual(composed);
  expect(history.redo()).toEqual(attachment);
  history.record({ before: attachment, after: mode, kind: "change" });
  history.record({ before: mode, after: snapshot(""), kind: "mode" });
  expect(history.undo()).toEqual(mode);
  expect(history.undo()).toEqual(attachment);
});
