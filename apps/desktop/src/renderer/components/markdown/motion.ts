/**
 * Motion layer for the markdown editor, on the app's standard curve.
 *
 * HARD RULE (learned the expensive way): never mutate classes, styles, or any
 * attribute on ProseMirror-managed content — PM's DOMObserver treats those as
 * external edits and re-renders the node, which can re-trigger observers in an
 * infinite loop. Content animates exclusively through the Web Animations API;
 * class toggling is reserved for elements WE own (the drag handle, overlays).
 */

export const EASE_STANDARD = "cubic-bezier(0.2, 0, 0, 1)";

const BLOCK_SELECTOR = "h1,h2,h3,h4,h5,h6,blockquote,ul,ol,li,pre,table,hr";

const isAnimatableBlock = (node: globalThis.Node): node is HTMLElement =>
  node instanceof HTMLElement &&
  (node.matches(BLOCK_SELECTOR) || node.tagName.includes("-"));

export function enterAnimation(el: HTMLElement) {
  el.animate(
    [
      { opacity: 0.3, transform: "translateY(4px) scale(0.99)" },
      { opacity: 1, transform: "none" },
    ],
    { duration: 180, easing: EASE_STANDARD },
  );
}

/**
 * Animate blocks the moment an input rule (typing "# ", "> ", "- ", "```" …)
 * or a drop creates them. Every transform replaces the paragraph with a new
 * block element, so one generic entrance covers every type; plain paragraphs
 * are excluded so ordinary typing/Enter stays calm.
 */
export function installBlockEntrances(pmRoot: HTMLElement): () => void {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const added of mutation.addedNodes) {
        if (isAnimatableBlock(added)) enterAnimation(added);
      }
    }
  });
  const start = requestAnimationFrame(() =>
    observer.observe(pmRoot, { childList: true, subtree: true }),
  );
  return () => {
    cancelAnimationFrame(start);
    observer.disconnect();
  };
}

/**
 * FLIP the reorder on block drag-and-drop: snapshot every top-level block's
 * position when a drag starts, then animate each surviving block from its old
 * position to its new one after the drop lands. The dropped block itself is
 * re-created by ProseMirror (no old position to FLIP from), so it gets the
 * entrance animation instead — covering paragraphs, which the entrance
 * observer deliberately skips.
 */
export function installDropFlip(pmRoot: HTMLElement): () => void {
  let dragTops: Map<Element, number> | null = null;
  const onDragStart = () => {
    dragTops = new Map();
    for (const el of pmRoot.children) {
      dragTops.set(el, el.getBoundingClientRect().top);
    }
  };
  const onDragEnd = () => {
    const prev = dragTops;
    dragTops = null;
    if (!prev) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        for (const el of pmRoot.children) {
          if (!(el instanceof HTMLElement)) continue;
          const oldTop = prev.get(el);
          if (oldTop === undefined) {
            enterAnimation(el);
            continue;
          }
          const dy = oldTop - el.getBoundingClientRect().top;
          if (Math.abs(dy) > 2) {
            el.animate(
              [{ transform: `translateY(${dy}px)` }, { transform: "none" }],
              { duration: 220, easing: EASE_STANDARD },
            );
          }
        }
      }),
    );
  };
  document.addEventListener("dragstart", onDragStart, true);
  document.addEventListener("dragend", onDragEnd, true);
  return () => {
    document.removeEventListener("dragstart", onDragStart, true);
    document.removeEventListener("dragend", onDragEnd, true);
  };
}

/**
 * Drag-handle appearance: hidden and slightly shrunk until the extension
 * first positions it (inline left/top on the handle element), fading in via
 * the base CSS transition, then gliding between blocks via the .glide class.
 * The handle and its wrapper are extension-owned chrome, not PM content, so
 * observing and classing them is safe.
 */
export function installHandleMotion(handle: HTMLElement): () => void {
  const wrapper = handle.parentElement;
  handle.classList.add("unpositioned");
  let shown = false;
  const sync = () => {
    const positioned = handle.style.left !== "" && handle.style.left !== "0px";
    const visible =
      positioned &&
      getComputedStyle(handle).visibility !== "hidden" &&
      (!wrapper || getComputedStyle(wrapper).visibility !== "hidden");
    if (visible && !shown) {
      handle.classList.remove("unpositioned");
      requestAnimationFrame(() =>
        requestAnimationFrame(() => handle.classList.add("glide")),
      );
    }
    if (!visible && shown) {
      handle.classList.remove("glide");
      handle.classList.add("unpositioned");
    }
    shown = visible;
  };
  const observer = new MutationObserver(sync);
  observer.observe(handle, { attributes: true, attributeFilter: ["style"] });
  if (wrapper) {
    observer.observe(wrapper, { attributes: true, attributeFilter: ["style"] });
  }
  return () => observer.disconnect();
}
