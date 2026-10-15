/**
 * A text selection does not rest in inert content
 * (docs/performance.md, "Stranded selections").
 *
 * Surfaces that hide while staying mounted (a minimised chat, a closed
 * palette or modal, another project's workspace) become inert. A caret left
 * inside one, as typing in a chat and then minimising it leaves it, is no
 * position the caret can take, and Chromium recomputes the visible selection
 * before every frame: each time it walks backwards through every inert
 * element looking for one it can use. Behind a few long minimised chats that
 * walk took 60 to 130 ms a frame. The selection is released as its container
 * turns inert, or as anything places it in content already inert; a range
 * reaching in from outside loses only its inert part.
 *
 * What was released comes back without taking focus from anything. A
 * highlight returns with its container; one in an editor only while nothing
 * holds focus, since setting a selection in an editable element focuses it.
 * A caret returns when its editor itself takes focus (a restored chat
 * focusing its composer): returning it with the container took focus from
 * whatever the person focused meanwhile (app.e2e.ts, "Cmd+W closes the tab
 * behind the floating chat when the tab has focus"). A press inside places
 * its own caret, so the saved one is dropped.
 */
export function installInertSelectionGuard(
  doc: Document = document,
): () => void {
  /** Released ranges, by the inert element that held them. */
  const released = new Map<Element, Range>();

  const release = (container: Element) => {
    const selection = doc.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0).cloneRange();
    const startInside = container.contains(range.startContainer);
    const endInside = container.contains(range.endContainer);
    if (!startInside && !endInside) return;
    if (startInside && endInside) {
      if (!range.collapsed || editingHost(range.startContainer)) {
        released.set(container, range);
      }
      selection.removeAllRanges();
      return;
    }
    // A range reaching into the container keeps its part outside it.
    if (startInside) range.setStartAfter(container);
    else range.setEndBefore(container);
    selection.removeAllRanges();
    if (!editingHost(range.startContainer) && !editingHost(range.endContainer))
      selection.addRange(range);
  };

  const returnHighlight = (container: Element) => {
    const range = released.get(container);
    const selection = doc.getSelection();
    if (!range || !selection || container.closest("[inert]")) return;
    // Returning a range in an editor focuses it: only a highlight, and only
    // while nothing holds focus (a project switched back to).
    const nothingFocused = !doc.activeElement || doc.activeElement === doc.body;
    if (
      editingHost(range.startContainer) &&
      (range.collapsed || !nothingFocused)
    )
      return;
    released.delete(container);
    if (selection.rangeCount === 0) selection.addRange(range);
  };

  const observer = new MutationObserver((mutations) => {
    for (const container of released.keys()) {
      if (!container.isConnected) released.delete(container);
    }
    for (const { target } of mutations) {
      if (!(target instanceof Element)) continue;
      if (target.hasAttribute("inert")) release(target);
      else returnHighlight(target);
    }
  });

  const onSelectionChange = () => {
    const selection = doc.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const inert =
      elementOf(range.startContainer)?.closest("[inert]") ??
      elementOf(range.endContainer)?.closest("[inert]");
    if (inert) release(inert);
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!(event.target instanceof Node)) return;
    for (const container of released.keys()) {
      if (container.contains(event.target)) released.delete(container);
    }
  };

  const onFocus = (event: FocusEvent) => {
    const focused = event.target;
    if (!(focused instanceof Element)) return;
    for (const [container, range] of released) {
      if (!container.isConnected || container.closest("[inert]")) continue;
      if (editingHost(range.startContainer) !== focused) continue;
      released.delete(container);
      const selection = doc.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
  };

  observer.observe(doc.documentElement, {
    attributes: true,
    attributeFilter: ["inert"],
    subtree: true,
  });
  doc.addEventListener("selectionchange", onSelectionChange);
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("focus", onFocus, true);
  return () => {
    observer.disconnect();
    doc.removeEventListener("selectionchange", onSelectionChange);
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("focus", onFocus, true);
    released.clear();
  };
}

function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

/**
 * The outermost contenteditable element holding `node`, or null when the
 * node is not editable (outside any editor, or in an editor's
 * contenteditable="false" island).
 */
function editingHost(node: Node): Element | null {
  let host: Element | null = null;
  for (
    let element = elementOf(node);
    element;
    element = element.parentElement
  ) {
    const editable = element.getAttribute("contenteditable");
    if (editable === "false") return host;
    if (editable !== null) host = element;
  }
  return host;
}
