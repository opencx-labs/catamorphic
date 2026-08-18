import type { Editor } from "@tiptap/core";
import { moveTableRow } from "./guardrails.js";
import { EASE_STANDARD } from "./motion.js";

/**
 * Table row reordering. No extension does this, so we own the whole gesture:
 * hovering a row shows a grip in the margin left of the table, dragging it
 * (pointer events, not native DnD — we own the indicator and motion) tracks a
 * drop boundary between rows, and release dispatches a single transaction
 * that replaces the table with reordered rows (one undo step). The header row
 * stays put: in markdown the first row IS the header, so reordering it would
 * change every column's meaning.
 *
 * All overlay elements live OUTSIDE the ProseMirror DOM (see motion.ts hard
 * rule) and are positioned relative to `mount`, the positioned ancestor that
 * scrolls with the document — so overlays track content through scrolling.
 */

export interface RowDragElements {
  /** Positioned ancestor of the editor content; overlays are its children. */
  mount: HTMLElement;
  grip: HTMLElement;
  indicator: HTMLElement;
  tint: HTMLElement;
}

export function installRowDrag(
  editor: Editor,
  elements: RowDragElements,
): () => void {
  const { mount, grip, indicator, tint } = elements;
  const pmRoot = editor.view.dom;

  /** Viewport rect → coordinates relative to the mount. */
  const rel = (rect: DOMRect) => {
    const base = mount.getBoundingClientRect();
    return { x: rect.left - base.left, y: rect.top - base.top };
  };

  let gripRow: HTMLTableRowElement | null = null;
  let drag: {
    tableDom: HTMLTableElement;
    rows: HTMLTableRowElement[];
    src: number;
    target?: number;
  } | null = null;

  const hideGrip = () => {
    gripRow = null;
    grip.classList.remove("show", "glide");
  };

  const onMouseMove = (event: MouseEvent) => {
    if (drag) {
      const { rows, tableDom } = drag;
      const lastRow = rows[rows.length - 1];
      if (!lastRow) return;
      let index = rows.length;
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i]?.getBoundingClientRect();
        if (r && event.clientY < r.top + r.height / 2) {
          index = i;
          break;
        }
      }
      drag.target = index;
      const tableRect = tableDom.getBoundingClientRect();
      const boundaryRow = rows[index];
      const boundaryTop = boundaryRow
        ? boundaryRow.getBoundingClientRect().top
        : lastRow.getBoundingClientRect().bottom;
      const at = rel(tableRect);
      indicator.style.display = "block";
      indicator.style.left = `${at.x}px`;
      indicator.style.width = `${tableRect.width}px`;
      indicator.style.top = `${boundaryTop - mount.getBoundingClientRect().top - 1}px`;
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest<HTMLTableRowElement>(".cat-mdedit tr") ?? null;
    if (row && row.rowIndex > 0 && pmRoot.contains(row)) {
      const wasShown = grip.classList.contains("show");
      gripRow = row;
      const rowRect = row.getBoundingClientRect();
      const tableRect = row.closest("table")!.getBoundingClientRect();
      const at = rel(rowRect);
      grip.style.left = `${rel(tableRect).x - 22}px`;
      grip.style.top = `${at.y + (rowRect.height - 22) / 2}px`;
      grip.classList.add("show");
      if (!wasShown) {
        grip.classList.remove("glide");
        requestAnimationFrame(() =>
          requestAnimationFrame(() => grip.classList.add("glide")),
        );
      }
    } else if (grip.classList.contains("show")) {
      // Keep the grip alive while the mouse crosses the gap between the
      // table edge and the grip (and over the grip itself).
      const g = grip.getBoundingClientRect();
      const near =
        event.clientX >= g.left - 6 &&
        event.clientX <= g.right + 26 &&
        event.clientY >= g.top - 8 &&
        event.clientY <= g.bottom + 8;
      if (!near) hideGrip();
    }
  };

  const onGripDown = (event: MouseEvent) => {
    if (!gripRow) return;
    event.preventDefault();
    const tableDom = gripRow.closest("table");
    if (!tableDom) return;
    const rows = [...tableDom.querySelectorAll("tr")];
    drag = { tableDom, rows, src: rows.indexOf(gripRow) };
    const rowRect = gripRow.getBoundingClientRect();
    const at = rel(rowRect);
    tint.style.display = "block";
    tint.style.left = `${at.x}px`;
    tint.style.top = `${at.y}px`;
    tint.style.width = `${rowRect.width}px`;
    tint.style.height = `${rowRect.height}px`;
    grip.classList.remove("show");
    document.body.style.cursor = "grabbing";
  };

  const onMouseUp = () => {
    if (!drag) return;
    const { rows, src, target, tableDom } = drag;
    drag = null;
    indicator.style.display = "none";
    tint.style.display = "none";
    document.body.style.cursor = "";
    if (target === undefined || target === src || target === src + 1) return;

    // FLIP prep: rows are re-created by the transaction, so snapshot tops by
    // OLD index and animate the new DOM rows via the order mapping.
    const prevTops = rows.map((row) => row.getBoundingClientRect().top);
    const order = rows.map((_, i) => i);
    order.splice(src, 1);
    order.splice(target > src ? target - 1 : target, 0, src);

    const view = editor.view;
    const $pos = view.state.doc.resolve(view.posAtDOM(tableDom, 0));
    let depth = $pos.depth;
    while (depth > 0 && $pos.node(depth).type.name !== "table") depth--;
    if (depth === 0) return;
    const move = moveTableRow({
      tableNode: $pos.node(depth),
      tablePos: $pos.before(depth),
      from: src,
      to: target,
    });
    view.dispatch(
      view.state.tr.replaceWith(move.replaceFrom, move.replaceTo, move.node),
    );

    requestAnimationFrame(() => {
      const freshTable = view.nodeDOM(move.replaceFrom);
      if (!(freshTable instanceof HTMLElement)) return;
      [...freshTable.querySelectorAll("tr")].forEach((row, j) => {
        const oldIndex = order[j];
        const prevTop = oldIndex === undefined ? undefined : prevTops[oldIndex];
        if (prevTop === undefined) return;
        const dy = prevTop - row.getBoundingClientRect().top;
        if (Math.abs(dy) > 2) {
          row.animate(
            [{ transform: `translateY(${dy}px)` }, { transform: "none" }],
            { duration: 220, easing: EASE_STANDARD },
          );
        }
      });
    });
  };

  document.addEventListener("mousemove", onMouseMove);
  grip.addEventListener("mousedown", onGripDown);
  document.addEventListener("mouseup", onMouseUp);
  return () => {
    document.removeEventListener("mousemove", onMouseMove);
    grip.removeEventListener("mousedown", onGripDown);
    document.removeEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "";
  };
}
