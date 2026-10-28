/**
 * A text selection does not rest in inert content
 * (docs/performance.md, "Stranded selections").
 *
 * Surfaces that hide while staying mounted (a minimised chat, a closed
 * palette or modal, another project's workspace) become inert. A caret left
 * inside one, as typing in a chat and then minimising it leaves it, is no
 * position the caret can take, and Chromium recomputes the visible selection
 * before every frame: each time it walks through inert
 * elements looking for one it can use. Behind a few long minimised chats that
 * walk took 60 to 130 ms a frame. A selection lying within one region that
 * turns inert, or that anything places in a region already inert, is
 * released; one only reaching in is left alone.
 * Nested inert regions still share their outer region: the nearest inert
 * ancestor of one endpoint need not contain the other endpoint.
 *
 * What was released comes back without moving focus, in its direction. A
 * highlight outside any editor returns with its container, or the ancestor
 * whose inertness held it, if nothing else is selected by then (otherwise
 * it is dropped). A caret or
 * highlight in an editor returns only when that editor itself takes focus
 * (a restored chat focusing its composer): a selection set in an editable
 * element focuses it, so returning one with its container took focus from
 * whatever the person had focused meanwhile (app.e2e.ts, "Cmd+W closes the
 * tab behind the floating chat when the tab has focus"). A press inside
 * places its own caret, so the saved one is dropped.
 *
 * Plain text that disappears leaves no invisible caret behind (ADR 0288).
 * Keep its raw node until a mutation arrives: a live Range would already
 * have moved to the surrounding boundary, which can precede a long hidden
 * transcript and cause the same native search. Editor carets and highlights
 * keep their existing behavior.
 */
export function installInertSelectionGuard(
  doc: Document = document,
): () => void {
  /** Released selections, by the inert element that held them. */
  const released = new Map<Element, Saved>();
  let plainCaret: { node: Node; hadText: boolean; position: Range } | null =
    null;

  const rememberPlainCaret = () => {
    const selection = doc.getSelection();
    const node = selection?.anchorNode;
    plainCaret =
      selection?.rangeCount &&
      selection.isCollapsed &&
      node &&
      !editingHost(node)
        ? {
            node,
            hadText: node.nodeType === Node.TEXT_NODE && node.nodeValue !== "",
            position: selection.getRangeAt(0).cloneRange(),
          }
        : null;
  };

  const discardDisappearedCaret = (mutations: MutationRecord[]) => {
    if (!plainCaret) return;
    const { node, hadText, position } = plainCaret;
    if (node.isConnected && !(hadText && node.nodeValue === "")) return;
    // splitText(0) empties the original node but adds its surviving text
    // beside it. A caret at zero stays in that original node in Chromium.
    const next = node.nextSibling;
    if (
      node.isConnected &&
      next?.nodeType === Node.TEXT_NODE &&
      next.nodeValue !== "" &&
      mutations.some(
        (mutation) =>
          mutation.type === "childList" &&
          mutation.target === node.parentNode &&
          [...mutation.addedNodes].includes(next),
      )
    )
      return;
    const selection = doc.getSelection();
    if (
      !selection?.rangeCount ||
      !selection.isCollapsed ||
      !selection.anchorNode ||
      (selection.anchorNode.nodeType === Node.TEXT_NODE &&
        selection.anchorNode.nodeValue !== "") ||
      editingHost(selection.anchorNode)
    )
      return;
    // The raw node proves its text disappeared; the cloned live range
    // follows every DOM adjustment. A selection subsequently made elsewhere
    // differs in node or offset and must remain alone.
    if (
      selection.anchorNode === position.startContainer &&
      selection.anchorOffset === position.startOffset
    ) {
      selection.removeAllRanges();
    }
  };

  const release = (container: Element) => {
    const selection = doc.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const { anchorNode, focusNode } = selection;
    if (!anchorNode || !focusNode) return;
    if (!container.contains(anchorNode) || !container.contains(focusNode)) {
      return;
    }
    const anchor = doc.createRange();
    anchor.setStart(anchorNode, selection.anchorOffset);
    const focus = doc.createRange();
    focus.setStart(focusNode, selection.focusOffset);
    const editor = editingHost(anchorNode);
    if (editor || !selection.isCollapsed) {
      released.set(container, { anchor, focus, editor });
    }
    selection.removeAllRanges();
  };

  const putBack = (container: Element, saved: Saved) => {
    released.delete(container);
    const { anchor, focus } = saved;
    if (inInert(anchor.startContainer) || inInert(focus.startContainer)) {
      return;
    }
    doc
      .getSelection()
      ?.setBaseAndExtent(
        anchor.startContainer,
        anchor.startOffset,
        focus.startContainer,
        focus.startOffset,
      );
  };

  const observer = new MutationObserver((mutations) => {
    discardDisappearedCaret(mutations);
    const returned: Element[] = [];
    for (const { type, target } of mutations) {
      if (type !== "attributes") continue;
      if (!(target instanceof Element)) continue;
      if (target.hasAttribute("inert")) release(target);
      else returned.push(target);
    }
    for (const container of released.keys()) {
      if (!container.isConnected) released.delete(container);
    }
    // A highlight returns with its container, or with an ancestor whose
    // inertness held it, once the person has selected nothing else.
    for (const target of returned) {
      for (const [container, saved] of released) {
        if (saved.editor || !target.contains(container)) continue;
        if (container.closest("[inert]")) continue;
        if ((doc.getSelection()?.rangeCount ?? 0) > 0) {
          released.delete(container);
          continue;
        }
        putBack(container, saved);
      }
    }
    rememberPlainCaret();
  });

  const onSelectionChange = () => {
    rememberPlainCaret();
    const selection = doc.getSelection();
    if (!selection?.anchorNode || !selection.focusNode) return;
    // A folded region can hold just the anchor while its inert workspace
    // holds both ends. Find that common inert ancestor before releasing.
    for (
      let inert = elementOf(selection.anchorNode)?.closest("[inert]");
      inert;
      inert = inert.parentElement?.closest("[inert]")
    ) {
      if (!inert.contains(selection.focusNode)) continue;
      release(inert);
      rememberPlainCaret();
      return;
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!(event.target instanceof Node)) return;
    for (const container of released.keys()) {
      if (container.contains(event.target)) released.delete(container);
    }
  };

  const onFocus = (event: FocusEvent) => {
    for (const [container, saved] of released) {
      if (!saved.editor || saved.editor !== event.target) continue;
      if (!container.isConnected || container.closest("[inert]")) continue;
      putBack(container, saved);
      return;
    }
  };

  observer.observe(doc.documentElement, {
    attributes: true,
    attributeFilter: ["inert"],
    childList: true,
    characterData: true,
    subtree: true,
  });
  rememberPlainCaret();
  doc.addEventListener("selectionchange", onSelectionChange);
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("focus", onFocus, true);
  return () => {
    observer.disconnect();
    doc.removeEventListener("selectionchange", onSelectionChange);
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("focus", onFocus, true);
    released.clear();
    plainCaret = null;
  };
}

/**
 * A released selection: its anchor and focus as live collapsed ranges, so
 * they follow edits made meanwhile, and the editor holding it, if any.
 */
interface Saved {
  anchor: Range;
  focus: Range;
  editor: Element | null;
}

function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

function inInert(node: Node): boolean {
  return !!elementOf(node)?.closest("[inert]");
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
    const editable = element.getAttribute("contenteditable")?.toLowerCase();
    if (editable === "false") return host;
    if (editable !== undefined) host = element;
  }
  return host;
}
