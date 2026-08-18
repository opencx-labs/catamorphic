import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Fragment } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/**
 * Formatting guardrails, enforced by an appendTransaction normalizer so bad
 * document states are unrepresentable rather than merely discouraged:
 *
 * 1. Never two consecutive empty paragraphs (max one blank line between any
 *    two blocks). The empty paragraph holding the cursor is exempt, so
 *    pressing Enter after a blank line lands you on a typeable line — it
 *    becomes non-empty the moment you type, and an abandoned double-blank is
 *    swept up by the next edit.
 * 2. Adjacent same-type lists merge back into one. Deleting a list item can
 *    split a list in two in ProseMirror, which then reads (and drags) as two
 *    separate groups; markdown would re-merge them on reparse anyway, so the
 *    editor keeps them merged live.
 *
 * Each pass applies one operation class; ProseMirror re-runs appendTransaction
 * on the appended result, so the other class converges on the next round.
 */

const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList"]);

interface Deletion {
  from: number;
  to: number;
}

export const MarkdownGuardrails = Extension.create({
  name: "markdownGuardrails",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("markdownGuardrails"),
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          const cursor = newState.selection.head;
          const extraBlanks: Deletion[] = [];
          const listJoins: number[] = [];

          const scan = (parent: PmNode, basePos: number) => {
            let prevEmpty = false;
            let prevType: string | null = null;
            let offset = 0;
            parent.forEach((child) => {
              const pos = basePos + offset;
              const empty =
                child.type.name === "paragraph" && child.content.size === 0;
              const holdsCursor =
                cursor >= pos && cursor <= pos + child.nodeSize;
              if (empty && prevEmpty && !holdsCursor) {
                extraBlanks.push({ from: pos, to: pos + child.nodeSize });
              }
              if (
                LIST_TYPES.has(child.type.name) &&
                child.type.name === prevType
              ) {
                listJoins.push(pos);
              }
              prevEmpty = empty;
              prevType = child.type.name;
              if (child.isBlock && child.childCount > 0) scan(child, pos + 1);
              offset += child.nodeSize;
            });
          };
          scan(newState.doc, 0);

          if (extraBlanks.length === 0 && listJoins.length === 0) return null;
          const tr = newState.tr;
          // Reverse order so earlier positions stay valid without mapping.
          if (extraBlanks.length > 0) {
            for (const blank of [...extraBlanks].reverse()) {
              tr.delete(blank.from, blank.to);
            }
          } else {
            for (const join of [...listJoins].reverse()) {
              tr.join(join);
            }
          }
          return tr;
        },
      }),
    ];
  },
});

/** Reorder a table's rows with a single transaction (one undo step). */
export function moveTableRow(opts: {
  tableNode: PmNode;
  tablePos: number;
  from: number;
  to: number;
}): { node: PmNode; replaceFrom: number; replaceTo: number } {
  const { tableNode, tablePos, from, to } = opts;
  const rows: PmNode[] = [];
  tableNode.forEach((row) => rows.push(row));
  const moved = rows.splice(from, 1)[0];
  if (!moved) throw new Error(`moveTableRow: no row at index ${from}`);
  rows.splice(to > from ? to - 1 : to, 0, moved);
  return {
    node: tableNode.copy(Fragment.fromArray(rows)),
    replaceFrom: tablePos,
    replaceTo: tablePos + tableNode.nodeSize,
  };
}
