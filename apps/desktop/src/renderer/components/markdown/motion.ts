/**
 * Motion layer for the markdown editor, on the app's standard curve.
 *
 * HARD RULE (learned the expensive way): never mutate classes, styles, or any
 * attribute on ProseMirror-managed content — PM's DOMObserver treats those as
 * external edits and re-renders the node, which can re-trigger observers in an
 * infinite loop. Content animates exclusively through the Web Animations API;
 * class toggling is reserved for elements WE own (the drag handle, overlays).
 */

import { EASE_STANDARD, motionMs } from "../../lib/motion.js";

export { EASE_STANDARD };

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
    { duration: motionMs(180), easing: EASE_STANDARD },
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
              { duration: motionMs(220), easing: EASE_STANDARD },
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

/** The selection bubble's enter (and, reversed, exit) duration. */
const BUBBLE_MS = 160;

/** The bubble's pose at `shown` (0 = hidden, 1 = in place). */
const bubblePose = (shown: number): Keyframe => ({
  opacity: shown,
  transform: `translateY(${4 * (1 - shown)}px) scale(${1 - 0.03 * (1 - shown)})`,
});

export interface BubbleMotion {
  /** The extension's `onShow`: it has shown and placed the anchor. */
  show: () => void;
  /** The extension's `onHide`: it has hidden and detached the anchor. */
  hide: () => void;
  /** Hold the bar out while the button is down in the editor; returns cleanup. */
  attach: (editorDom: HTMLElement) => () => void;
}

/**
 * Selection bubble enter and exit. Tiptap's BubbleMenu shows, places and
 * hides `anchor`, and detaches it the moment it hides; the bar inside is
 * ours and animates. It enters rising 4px from 97% and transparent, and
 * leaves the same way back over the same time and curve. A leaving bar
 * keeps its place: the anchor goes back into `layer` (the extension never
 * moves a hidden menu) and the bar alone stays visible, inert, until its
 * exit ends, when the anchor is detached again as the extension left it.
 * Shown again mid-exit, it turns around from where it is; repositioned
 * while shown, it just moves. While the button is down in the editor
 * (drag-selecting) the bar stays out and arrives on mouse lift.
 */
export function createBubbleMotion({
  layer,
  anchor,
  bar,
}: {
  layer: HTMLElement;
  anchor: HTMLElement;
  bar: HTMLElement;
}): BubbleMotion {
  let extensionShown = false;
  let held = false;
  let presses = 0;
  let state: "hidden" | "shown" | "leaving" = "hidden";
  let animation: Animation | null = null;
  let disposed = false;

  const setState = (next: typeof state) => {
    state = next;
    bar.dataset.state = next;
    bar.inert = next !== "shown";
  };
  setState("hidden");
  /** How far in the bar is now: its live opacity, mid-animation too. */
  const progress = () => {
    if (state === "hidden") return 0;
    const opacity = Number.parseFloat(getComputedStyle(bar).opacity);
    return Number.isFinite(opacity) ? opacity : 1;
  };
  const animateTo = (target: 0 | 1, from: number) => {
    animation?.cancel();
    const run = bar.animate([bubblePose(from), bubblePose(target)], {
      duration: motionMs(BUBBLE_MS) * Math.abs(target - from),
      easing: EASE_STANDARD,
      fill: "forwards",
    });
    animation = run;
    run.onfinish = () => {
      if (animation !== run) return;
      animation = null;
      if (target === 0) {
        setState("hidden");
        if (!extensionShown) anchor.remove();
      }
      // The end pose is the bar's own (or it is hidden now): let go.
      run.cancel();
    };
  };
  const enter = () => {
    const from = progress();
    setState("shown");
    animateTo(1, from);
  };
  const leave = () => {
    if (!anchor.isConnected) layer.append(anchor);
    const from = progress();
    setState("leaving");
    animateTo(0, from);
  };
  const sync = () => {
    if (disposed) return;
    const wanted = extensionShown && !held;
    if (wanted && state !== "shown") enter();
    else if (!wanted && state === "shown") leave();
  };

  return {
    show: () => {
      extensionShown = true;
      sync();
    },
    hide: () => {
      extensionShown = false;
      // Mid-exit already (held), the extension just pulled it out again.
      if (!disposed && state === "leaving") layer.append(anchor);
      sync();
    },
    attach: (editorDom) => {
      const onEditorMouseDown = () => {
        held = true;
        presses += 1;
        sync();
      };
      // Two frames after lift, so a click that collapses the selection
      // hides the menu before the bar would come back.
      const onMouseUp = () => {
        if (!held) return;
        const press = presses;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (press !== presses) return;
            held = false;
            sync();
          }),
        );
      };
      // The editor's DOM node comes in now: the editor may already be
      // destroyed when this cleanup runs (tab close), and tiptap's `view`
      // getter THROWS post-destroy; removing a listener from a detached
      // node is harmless.
      editorDom.addEventListener("mousedown", onEditorMouseDown, true);
      document.addEventListener("mouseup", onMouseUp);
      return () => {
        disposed = true;
        animation?.cancel();
        editorDom.removeEventListener("mousedown", onEditorMouseDown, true);
        document.removeEventListener("mouseup", onMouseUp);
      };
    },
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
