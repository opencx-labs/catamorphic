import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

const LISTS = new Set(["bulletList", "orderedList", "taskList"]);

export interface HandleHoverGate {
  /** Ordered before the drag handle, whose hover it holds back. */
  extension: Extension;
  /** The block the handle now points at (from its onNodeChange). */
  track(view: EditorView, pos: number, node: PmNode | null): void;
}

/**
 * The drag handle finds the block under the pointer with a hit test and a
 * caret lookup on every animation frame the pointer moves, each forcing
 * layout. While the pointer stays on the block the handle already points
 * at, the answer cannot change, so this plugin, ordered before the
 * handle's, takes those moves and the handle's lookup runs only when the
 * pointer leaves the block. The block's box is read when the handle moves
 * to it, with layout fresh from the handle's own lookup, and forgotten when
 * the editor scrolls, the window, the editor or its scroller resizes, the
 * document changes or the handle hides. Blocks holding other drag targets
 * (a list, an item with a nested list) and tables are never held, so a
 * move onto an inner target still finds it. A block that moves any other
 * way (mid-entrance, a drop's reorder) keeps its old box until the pointer
 * leaves it.
 */
export function createHandleHoverGate(): HandleHoverGate {
  let box: DOMRect | null = null;
  const forget = () => {
    box = null;
  };

  const extension = Extension.create({
    name: "handleHoverGate",
    // Before the drag handle's plugin (priority 100): the first plugin
    // whose handler returns true takes the event from the rest.
    priority: 101,
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey("handleHoverGate"),
          view: (view) => {
            // Blocks move without an edit when the editor's container
            // resizes (the frontmatter panel opening above the document) or
            // the scroller around it does (a line appearing above it).
            const resized = new ResizeObserver(forget);
            const container = view.dom.parentElement;
            if (container) resized.observe(container);
            if (container?.parentElement) {
              resized.observe(container.parentElement);
            }
            // Only scrolls that move the editor: a chat streaming beside it
            // scrolls its own log on every frame.
            const onScroll = (event: Event) => {
              const scrolled = event.target;
              if (
                scrolled === document ||
                (scrolled instanceof globalThis.Node &&
                  scrolled.contains(view.dom))
              ) {
                forget();
              }
            };
            document.addEventListener("scroll", onScroll, true);
            window.addEventListener("resize", forget);
            return {
              update: (current, previous) => {
                if (!current.state.doc.eq(previous.doc)) forget();
              },
              destroy: () => {
                resized.disconnect();
                document.removeEventListener("scroll", onScroll, true);
                window.removeEventListener("resize", forget);
              },
            };
          },
          props: {
            handleDOMEvents: {
              mousemove: (_view, event) =>
                box !== null &&
                event.buttons === 0 &&
                event.clientY >= box.top &&
                event.clientY < box.bottom,
            },
          },
        }),
      ];
    },
  });

  return {
    extension,
    track: (view, pos, node) => {
      box = null;
      if (!node || !holdsNoTargets(node)) return;
      const dom = view.nodeDOM(pos);
      if (dom instanceof HTMLElement) box = dom.getBoundingClientRect();
    },
  };
}

/** A block with no drag target inside it, and not a table. */
function holdsNoTargets(node: PmNode): boolean {
  if (LISTS.has(node.type.name) || node.type.name === "table") return false;
  let nested = false;
  node.descendants((child) => {
    if (LISTS.has(child.type.name)) nested = true;
    return !nested;
  });
  return !nested;
}
