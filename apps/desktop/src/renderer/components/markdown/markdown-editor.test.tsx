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
