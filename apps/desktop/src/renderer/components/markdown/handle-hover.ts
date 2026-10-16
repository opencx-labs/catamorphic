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
 * pointer leaves the block. "On the block" is the move's target lying in
 * the block's element, which the browser has already found, so it holds
 * however blocks move (an image above loading, the properties box
 * growing) and reads no layout. Moves between blocks or beside them still
 * look up. Blocks holding other drag targets (a list, an item with a
 * nested list) and tables are never held, so a move onto an inner target
 * still finds it.
 */
export function createHandleHoverGate(): HandleHoverGate {
  const held: { block: Element | null } = { block: null };

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
          view: () => ({
            update: (current, previous) => {
              if (current.state.doc !== previous.doc) held.block = null;
            },
          }),
          props: {
            handleDOMEvents: {
              mousemove: (_view, event) =>
                held.block !== null &&
                event.buttons === 0 &&
                event.target instanceof globalThis.Node &&
                held.block.contains(event.target),
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
      if (!node || !holdsNoTargets(node)) return;
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
