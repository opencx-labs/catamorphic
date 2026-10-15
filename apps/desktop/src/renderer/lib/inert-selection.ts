/**
 * A text selection never rests in content that turned inert
 * (docs/performance.md, "Stranded selections").
 *
 * Surfaces that hide while staying mounted (a minimised chat, a closed
 * palette or modal, another project's workspace) become inert. A caret left
 * inside one, as typing in a chat and then minimising it leaves it, is no
 * position the caret can take, and Chromium recomputes the visible selection
 * before every frame: each time it walks backwards through every inert
 * element looking for one it can use. Behind a few long minimised chats that
 * walk took 60 to 130 ms a frame. Releasing the selection as its container
 * turns inert keeps the walk from starting.
 *
 * The released range comes back when focus next enters that container from
 * the keyboard or a script (a restored chat focusing its composer), so the
 * caret is where the person left it. Setting a selection in an editable
 * element focuses it, so the range waits for focus instead of returning with
 * the container: whatever the person focused meanwhile keeps focus. A press
 * inside places its own caret.
 */
export function installInertSelectionGuard(
  doc: Document = document,
): () => void {
  const released = new Map<Element, Range>();
  let pressed: EventTarget | null = null;

  const observer = new MutationObserver((mutations) => {
    const selection = doc.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    for (const { target } of mutations) {
      if (!(target instanceof Element) || !target.hasAttribute("inert")) {
        continue;
      }
      if (
        target.contains(selection.anchorNode) ||
        target.contains(selection.focusNode)
      ) {
        released.set(target, selection.getRangeAt(0).cloneRange());
        selection.removeAllRanges();
        return;
      }
    }
  });

  const onPointerDown = (event: PointerEvent) => {
    pressed = event.target;
    setTimeout(() => {
      pressed = null;
    }, 0);
  };
  const onFocus = (event: FocusEvent) => {
    const focused = event.target;
    if (!(focused instanceof Node)) return;
    for (const [container, range] of released) {
      if (!container.isConnected) {
        released.delete(container);
        continue;
      }
      if (container.hasAttribute("inert") || !container.contains(focused)) {
        continue;
      }
      released.delete(container);
      const fromPress = pressed instanceof Node && container.contains(pressed);
      if (
        !fromPress &&
        focused.contains(range.startContainer) &&
        focused.contains(range.endContainer)
      ) {
        const selection = doc.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
  };

  observer.observe(doc.documentElement, {
    attributes: true,
    attributeFilter: ["inert"],
    subtree: true,
  });
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("focus", onFocus, true);
  return () => {
    observer.disconnect();
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("focus", onFocus, true);
    released.clear();
  };
}
