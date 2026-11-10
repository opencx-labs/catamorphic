import { Extension } from "@tiptap/core";
import { dragHandlePluginDefaultKey } from "@tiptap/extension-drag-handle";
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
 * pointer leaves the block. "On the block" is the move's target lying in
 * the block's element, which the browser has already found, so it holds
 * however blocks move (an image above loading, the properties box
 * growing) and reads no layout. Moves between blocks or beside them still
 * look up. Blocks holding other drag targets (a list, an item with a
 * nested list) and tables are never held, so a move onto an inner target
 * still finds it.
 */
export function createHandleHoverGate(): HandleHoverGate {
  const held: { block: Element | null; item: Element | null } = {
    block: null,
    item: null,
  };
  // A list item's full box includes its descendants. Its own text row is
  // the hit region instead, with gaps assigned to the nearest row. Ignore X
  // in a list: the left apron must resolve to the same row as its text.
  let rows: { item: Element; line: Element; box: DOMRect }[] | null = null;
  const invalidate = () => {
    rows = null;
  };
  const listRow = (view: EditorView, event: MouseEvent) => {
    const origin = view.dom.getBoundingClientRect();
    rows ??= [
      ...view.dom.querySelectorAll("li :is(p,pre,h1,h2,h3,h4,h5,h6)"),
    ].flatMap((line) => {
      // Quotes can contain further lists. Only the nearest item's own
      // text blocks count, never a container covering descendant items.
      const item = line.closest("li");
      if (!item) return [];
      const rect = line.getBoundingClientRect();
      return [
        {
          item,
          line,
          box: DOMRect.fromRect({
            x: rect.left - origin.left,
            y: rect.top - origin.top,
            width: rect.width,
            height: rect.height,
          }),
        },
      ];
    });
    const list = [...view.dom.children].find((child) => {
      if (!child.matches("ul,ol")) return false;
      const box = child.getBoundingClientRect();
      return event.clientY >= box.top && event.clientY <= box.bottom;
    });
    if (!list) return null;
    let best: (typeof rows)[number] | null = null;
    let distance = Number.POSITIVE_INFINITY;
    for (const row of rows) {
      if (!list.contains(row.item)) continue;
      const away = Math.max(
        row.box.top - (event.clientY - origin.top),
        event.clientY - origin.top - row.box.bottom,
        0,
      );
      if (away < distance) {
        best = row;
        distance = away;
      }
    }
    return best;
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
          // An edit can give the held element to another position.
          view: (view) => {
            const resize =
              typeof ResizeObserver === "undefined"
                ? null
                : new ResizeObserver(invalidate);
            resize?.observe(view.dom);
            view.dom.ownerDocument.addEventListener("scroll", invalidate, true);
            return {
              update: (current, previous) => {
                if (current.state.doc !== previous.doc) {
                  held.block = null;
                  held.item = null;
                  invalidate();
                }
              },
              destroy: () => {
                resize?.disconnect();
                view.dom.ownerDocument.removeEventListener(
                  "scroll",
                  invalidate,
                  true,
                );
              },
            };
          },
          props: {
            handleDOMEvents: {
              mousemove: (view, event) => {
                if (event.buttons !== 0) return false;
                if (
                  held.block &&
                  event.target instanceof globalThis.Node &&
                  held.block.contains(event.target)
                )
                  return true;
                const row = listRow(view, event);
                if (!row) return false;
                if (held.item === row.item) return true;
                const origin = view.dom.getBoundingClientRect();
                const plugin = dragHandlePluginDefaultKey.get(view.state);
                const move = plugin?.props.handleDOMEvents?.mousemove;
                if (!plugin || !move) return false;
                move.call(
                  plugin,
                  view,
                  new MouseEvent("mousemove", {
                    clientX:
                      origin.left +
                      row.box.left +
                      Math.min(8, row.box.width / 2),
                    clientY: Math.max(
                      origin.top + row.box.top + 1,
                      Math.min(event.clientY, origin.top + row.box.bottom - 1),
                    ),
                  }),
                );
                return true;
              },
            },
          },
        }),
      ];
    },
  });

  return {
    extension,
    track: (view, pos, node) => {
      held.block = null;
      held.item = null;
      if (!node) return;
      if (node.type.name === "listItem" || node.type.name === "taskItem") {
        const item = view.nodeDOM(pos);
        // Only the item's own paragraph holds moves; nested rows must pass.
        if (item instanceof Element) {
          held.item = item;
          held.block = item.querySelector(":scope > p, :scope > div > p");
        }
        return;
      }
      if (!holdsNoTargets(node)) return;
      const dom = view.nodeDOM(pos);
      if (dom instanceof Element) held.block = dom;
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
