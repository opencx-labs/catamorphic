// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MarkdownEditor } from "./markdown-editor.js";

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
// The drag handle's hover gate forgets its block when the editor resizes.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

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
