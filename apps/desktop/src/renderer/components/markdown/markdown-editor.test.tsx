// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  appIsMovingFocus,
  notePersonInput,
  personInputCount,
  personMovedOn,
} from "../../lib/app-focus.js";
import { MarkdownEditor, type MarkdownEditorProps } from "./markdown-editor.js";

const plan = (counts: string) =>
  [
    "# Product Night",
    "",
    "| Meal | Count |",
    "| --- | --- |",
    counts,
    "",
    "- [x] Book the room",
    "- [ ] Meal counts",
    "",
  ].join("\n");

// ProseMirror measures selections to scroll them into view; jsdom has no layout.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

/** Keep real editor initialization, but deliver its frames only when asked. */
function holdAnimationFrames() {
  const frames = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  const request = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    });
  const cancel = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation((id) => {
      frames.delete(id);
    });
  return {
    frames,
    release: () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(performance.now());
    },
    restore: () => {
      request.mockRestore();
      cancel.mockRestore();
    },
  };
}

it("leaves focus and the selection reader alone when the person opens a menu before initialization finishes", async () => {
  const frames = holdAnimationFrames();
  const inputs = personInputCount();
  const onSelectionReader = vi.fn();
  const opened = await openDoc("# Plan\n", {
    canAutofocus: () => !personMovedOn(inputs),
    onSelectionReader,
  });
  const menu = document.createElement("button");
  menu.setAttribute("role", "menuitem");
  document.body.append(menu);
  try {
    notePersonInput();
    menu.focus();
    await act(async () => frames.release());
    expect(document.activeElement).toBe(menu);
    expect(onSelectionReader).not.toHaveBeenCalled();
  } finally {
    opened.close();
    menu.remove();
    opened.node.remove();
    frames.restore();
  }
});

it("focuses an ordinarily opened document as the app, and publishes its reader after focus", async () => {
  const frames = holdAnimationFrames();
  const onSelectionReader = vi.fn();
  const opened = await openDoc("# Plan\n", {
    canAutofocus: () => true,
    onSelectionReader,
  });
  const focusAsApp = vi.fn(() => appIsMovingFocus());
  opened.editor.view.dom.addEventListener("focus", focusAsApp);
  try {
    expect(onSelectionReader).not.toHaveBeenCalled();
    await act(async () => frames.release());
    expect(document.activeElement).toBe(opened.editor.view.dom);
    expect(focusAsApp).toHaveReturnedWith(true);
    expect(onSelectionReader).toHaveBeenCalledWith(expect.any(Function));
    expect(opened.editor.state.selection.from).toBe(1);
  } finally {
    opened.close();
    opened.node.remove();
    frames.restore();
  }
});

it("cancels the document's initial focus frame on unmount", async () => {
  const frames = holdAnimationFrames();
  const opened = await openDoc("# Plan\n");
  try {
    expect(frames.frames.size).toBeGreaterThan(0);
    opened.close();
    expect(frames.frames.size).toBe(0);
    expect(() => frames.release()).not.toThrow();
  } finally {
    opened.node.remove();
    frames.restore();
  }
});

it("uses the latest focus permission when the initial frame is delivered", async () => {
  const frames = holdAnimationFrames();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const allowed = vi.fn(() => true);
  const denied = vi.fn(() => false);
  const onSelectionReader = vi.fn();
  const render = (canAutofocus: () => boolean) =>
    act(async () =>
      root.render(
        <MarkdownEditor
          value="# Plan\n"
          onChange={() => {}}
          canAutofocus={canAutofocus}
          onSelectionReader={onSelectionReader}
        />,
      ),
    );
  try {
    await render(allowed);
    await render(denied);
    await act(async () => frames.release());
    expect(allowed).not.toHaveBeenCalled();
    expect(denied).toHaveBeenCalledOnce();
    expect(onSelectionReader).not.toHaveBeenCalled();
    expect(node.contains(document.activeElement)).toBe(false);
  } finally {
    act(() => root.unmount());
    node.remove();
    frames.restore();
  }
});

it("loads a file changed on disk without reporting it as an edit", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const onChange = vi.fn();
  const render = (value: string) =>
    act(async () =>
      root.render(<MarkdownEditor value={value} onChange={onChange} />),
    );

  // The host keeps a draft only for markdown that differs from the file, so
  // anything emitted while nobody types must be the file itself.
  const opened = plan("| Standard | 40 |");
  await render(opened);
  expect(node.textContent).toContain("40");
  for (const [markdown] of onChange.mock.calls) expect(markdown).toBe(opened);

  onChange.mockClear();
  const changed = plan("| Standard | 41 |\n| Vegan | 5 |");
  await render(changed);
  expect(node.textContent).toContain("Vegan");
  for (const [markdown] of onChange.mock.calls) expect(markdown).toBe(changed);
  act(() => root.unmount());
});

it("keeps images: a document opening on one, and their markdown after edits", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const onChange = vi.fn();
  // An image first and a list last: the trailing paragraph the editor adds
  // after a list once replaced content in a document holding a bare text
  // node, which ProseMirror rejected.
  const doc = [
    "![Work logo](assets/logo%20v2.png)",
    "",
    'Inline ![chart](https://example.invalid/c.png "Q3") stays inline.',
    "",
    "- one",
    "- two",
    "",
  ].join("\n");
  await act(async () =>
    root.render(<MarkdownEditor value={doc} onChange={onChange} />),
  );
  const handle = Reflect.get(window, "__catMarkdownEditor");
  const editor = handle.editor;
  expect(() => editor.state.doc.check()).not.toThrow();
  expect(node.querySelectorAll(".cat-mdedit-image")).toHaveLength(2);
  expect(node.textContent).toContain("Work logo");

  await act(async () => {
    const inserted = editor.commands.insertContentAt(
      editor.state.doc.content.size,
      "<p>Added.</p>",
    );
    expect(inserted).toBe(true);
  });
  const saved = String(onChange.mock.calls.at(-1)?.[0] ?? "");
  expect(saved).toContain("![Work logo](assets/logo%20v2.png)");
  expect(saved).toContain(
    'Inline ![chart](https://example.invalid/c.png "Q3") stays inline.',
  );
  expect(saved).toContain("Added.");
  act(() => root.unmount());
});

/** Mounts the editor on `doc`; returns its editor and the last emission. */
async function openDoc(
  doc: string,
  props?: Pick<
    MarkdownEditorProps,
    "documentPath" | "readImage" | "canAutofocus" | "onSelectionReader"
  >,
) {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const onChange = vi.fn();
  await act(async () =>
    root.render(<MarkdownEditor value={doc} onChange={onChange} {...props} />),
  );
  const editor = Reflect.get(window, "__catMarkdownEditor").editor;
  const append = (text: string) =>
    act(async () => {
      editor.commands.insertContentAt(
        editor.state.doc.content.size,
        `<p>${text}</p>`,
      );
    });
  const saved = () => String(onChange.mock.calls.at(-1)?.[0] ?? "");
  const close = () => act(() => root.unmount());
  return { node, editor, append, saved, close };
}

it("keeps a linked image's link, and writes a reference image inline", async () => {
  const doc = [
    "[![build](https://ci.example.com/badge.svg)](https://ci.example.com)",
    "",
    "![logo][brand]",
    "",
    "[brand]: https://example.com/logo.png",
    "",
  ].join("\n");
  const opened = await openDoc(doc);
  expect(() => opened.editor.state.doc.check()).not.toThrow();
  await opened.append("Added.");
  // The badge as written; the reference resolved, since the editor drops
  // link definitions.
  expect(opened.saved()).toContain(
    "[![build](https://ci.example.com/badge.svg)](https://ci.example.com)",
  );
  expect(opened.saved()).toContain("![logo](https://example.com/logo.png)");
  opened.close();
});

it("writes a link put on an image around it", async () => {
  const opened = await openDoc("![logo](logo.png)\n\nText.\n");
  await act(async () => {
    opened.editor.commands.setNodeSelection(1);
    opened.editor.commands.setLink({ href: "https://example.com" });
  });
  expect(opened.saved()).toContain("[![logo](logo.png)](https://example.com)");
  opened.close();
});

it("pastes a copied image back as the same image, and copies its markdown as text", async () => {
  // ProseMirror's pasteHTML dispatches a paste event; jsdom has no
  // ClipboardEvent.
  vi.stubGlobal(
    "ClipboardEvent",
    class extends Event {
      clipboardData = null;
    },
  );
  const opened = await openDoc(
    '![Work logo](assets/logo.png "Brand")\n\nText.\n',
  );
  const { view } = opened.editor;
  let imagePos = -1;
  view.state.doc.descendants(
    (child: { type: { name: string } }, pos: number) => {
      if (child.type.name === "image") imagePos = pos;
    },
  );
  opened.editor.commands.setNodeSelection(imagePos);
  const copied = view.serializeForClipboard(view.state.selection.content());
  expect(copied.text).toBe('![Work logo](assets/logo.png "Brand")');
  await act(async () => {
    opened.editor.commands.setTextSelection(
      opened.editor.state.doc.content.size - 1,
    );
    view.pasteHTML(copied.dom.innerHTML);
  });
  await opened.append("Added.");
  const images = opened
    .saved()
    .match(/!\[Work logo\]\(assets\/logo\.png "Brand"\)/g);
  expect(images).toHaveLength(2);
  opened.close();
});

it("shows a document's images through its reader, and names one it cannot show", async () => {
  // jsdom loads no images: one with a source counts as loaded.
  const complete = vi
    .spyOn(HTMLImageElement.prototype, "complete", "get")
    .mockReturnValue(true);
  const width = vi
    .spyOn(HTMLImageElement.prototype, "naturalWidth", "get")
    .mockReturnValue(16);
  const readImage = vi.fn(async (path: string) =>
    path === "docs/assets/logo v2.png" ? "data:image/png;base64,AAAA" : null,
  );
  const opened = await openDoc(
    [
      "![Work logo](assets/logo%20v2.png)",
      "",
      "A badge ![build](https://ci.example.com/badge.svg) and ![Missing](../gone.png), and ![plain](http://example.com/a.png).",
      "",
    ].join("\n"),
    { documentPath: "docs/notes.md", readImage },
  );
  await act(async () => {});
  expect(readImage.mock.calls.map(([path]) => path).sort()).toEqual([
    "docs/assets/logo v2.png",
    "gone.png",
  ]);
  const images = [...opened.node.querySelectorAll(".cat-mdedit-image")];
  expect(
    images.map((image) => ({
      state: image.getAttribute("data-state"),
      src: image.querySelector("img")?.getAttribute("src") ?? null,
      label: image.getAttribute("aria-label"),
    })),
  ).toEqual([
    {
      state: "loaded",
      src: "data:image/png;base64,AAAA",
      label: null,
    },
    {
      state: "loaded",
      src: "https://ci.example.com/badge.svg",
      label: null,
    },
    { state: "failed", src: null, label: "Missing, could not be shown" },
    { state: "failed", src: null, label: "plain, could not be shown" },
  ]);
  // Shown, the markdown is still as written.
  await opened.append("Added.");
  expect(opened.saved()).toContain("![Work logo](assets/logo%20v2.png)");
  opened.close();
  complete.mockRestore();
  width.mockRestore();
});
