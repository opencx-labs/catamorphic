interface Item {
  /** Each line of text, or the icon's box. */
  lines: DOMRect[];
  icon: boolean;
}

/**
 * A closing sidebar's items leave before it does (ADR 0200, amended
 * 2026-10-09). Each item the person can see (a line of text, an icon)
 * slides toward the edge the sidebar leaves by and fades, in a sweep from
 * the top. Text travels its own length and draws a thread behind it, a
 * hairline in its own color that ends where the text ended, so the thread
 * spans where the text was and never crosses it. The panel follows a beat
 * later (its transition delay in styles.css) and carries the threads away.
 *
 * What moves is the closest box around each run of text or icon, since a
 * transform does not apply to an inline box. Returns the cleanup, which
 * puts every item back.
 */
export function leaveSidebar(panel: HTMLElement): () => void {
  const box = panel.getBoundingClientRect();
  const items = new Map<Element, Item>();
  const visible = (rect: DOMRect | undefined): rect is DOMRect =>
    rect !== undefined && rect.width >= 2 && rect.height >= 2;
  // What clips an element on screen: the panel and every box between that
  // clips its overflow (a scrolled list, a truncated label).
  const clips = new Map<Element, DOMRect[]>();
  const clipsOf = (element: Element): DOMRect[] => {
    const known = clips.get(element);
    if (known) return known;
    const parent = element.parentElement;
    const outer = !parent || parent === panel ? [box] : clipsOf(parent);
    const style = getComputedStyle(element);
    const own =
      style.overflowX === "visible" && style.overflowY === "visible"
        ? outer
        : [...outer, element.getBoundingClientRect()];
    clips.set(element, own);
    return own;
  };

  const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    // Off screen (scrolled away, a hidden tab): skipped before any style
    // is read, so a long list costs only what shows.
    const near = node.parentElement?.getBoundingClientRect();
    if (!near || near.bottom <= box.top || near.top >= box.bottom) continue;
    if (near.width === 0 && near.height === 0) continue;
    const item = movable(node.parentElement, panel);
    if (!item || !shown(item)) continue;
    const bounds = clipsOf(item);
    range.selectNodeContents(node);
    for (const line of range.getClientRects()) {
      const rect = intersect(line, bounds);
      if (!visible(rect)) continue;
      const entry = items.get(item) ?? { lines: [], icon: false };
      const same = entry.lines.findIndex(
        (known) =>
          Math.min(known.bottom, rect.bottom) - Math.max(known.top, rect.top) >
          Math.min(known.height, rect.height) / 2,
      );
      if (same === -1) entry.lines.push(rect);
      else entry.lines[same] = union(entry.lines[same] ?? rect, rect);
      items.set(item, entry);
    }
  }
  for (const icon of panel.querySelectorAll("svg")) {
    if (icon.parentElement?.closest("svg") || !shown(icon)) continue;
    const rect = intersect(icon.getBoundingClientRect(), clipsOf(icon));
    if (visible(rect)) items.set(icon, { lines: [rect], icon: true });
  }

  // An item inside another that moves would move twice.
  const outermost = [...items].filter(
    (entry): entry is [HTMLElement | SVGElement, Item] =>
      (entry[0] instanceof HTMLElement || entry[0] instanceof SVGElement) &&
      !hasAncestor(entry[0], items, panel),
  );
  const motions = new Map<Element, { delay: number; distance?: number }>();
  for (const [element, { lines, icon }] of outermost) {
    if (icon) continue;
    const top = Math.min(...lines.map((line) => line.top));
    motions.set(element, {
      // The sweep crosses the panel in the same time, however many rows.
      delay: Math.round(
        Math.max(0, Math.min(1, (top - box.top) / box.height)) * 60,
      ),
      distance: Math.max(...lines.map((line) => line.width)),
    });
  }
  const labels = outermost.filter(([, { icon }]) => !icon);
  for (const [element, { lines, icon }] of outermost) {
    if (!icon) continue;
    const [rect] = lines;
    if (!rect) continue;
    // An icon leading a label (a row's icon) travels with it, so the two
    // leave as one; any other takes a step out from its row's moment.
    const middle = rect.top + rect.height / 2;
    const row = labels.filter(([, text]) =>
      text.lines.some((line) => line.top <= middle && line.bottom >= middle),
    );
    const label = row.find(([, text]) =>
      text.lines.some(
        (line) => line.left >= rect.right - 2 && line.left - rect.right < 16,
      ),
    );
    const moment = motions.get((label ?? row[0])?.[0] ?? element);
    motions.set(element, {
      delay:
        moment?.delay ??
        Math.round(
          Math.max(0, Math.min(1, (rect.top - box.top) / box.height)) * 60,
        ),
      ...(label ? { distance: moment?.distance } : {}),
    });
  }

  const traces = document.createElement("div");
  traces.className = "sidebar-traces";
  traces.setAttribute("aria-hidden", "true");
  for (const [element, { lines, icon }] of outermost) {
    const motion = motions.get(element);
    if (!motion) continue;
    element.style.setProperty("--leave-delay", `${motion.delay}ms`);
    if (motion.distance !== undefined)
      element.style.setProperty("--leave-distance", `${motion.distance}px`);
    element.setAttribute("data-sidebar-leaving", "");
    if (icon) continue;
    const color = getComputedStyle(element).color;
    for (const line of lines) {
      const trace = document.createElement("div");
      trace.className = "sidebar-trace";
      trace.style.cssText = [
        `left: ${line.left - box.left}px`,
        `top: ${Math.round(line.top - box.top + line.height / 2)}px`,
        `width: ${line.width}px`,
        `--trace-color: ${color}`,
        `--leave-delay: ${motion.delay}ms`,
      ].join("; ");
      traces.append(trace);
    }
  }
  panel.append(traces);

  return () => {
    traces.remove();
    for (const [element] of outermost) {
      element.removeAttribute("data-sidebar-leaving");
      element.style.removeProperty("--leave-delay");
      element.style.removeProperty("--leave-distance");
    }
  };
}

/** Drawn and seen: not hidden, and not see-through (a row's hover actions). */
function shown(element: Element): boolean {
  return element.checkVisibility({
    checkOpacity: true,
    checkVisibilityCSS: true,
  });
}

/** The closest box a transform moves: inline boxes and `contents` do not. */
function movable(
  element: Element | null,
  panel: HTMLElement,
): Element | undefined {
  for (
    let current = element;
    current && current !== panel;
    current = current.parentElement
  ) {
    const display = getComputedStyle(current).display;
    if (display !== "inline" && display !== "contents") return current;
  }
  return undefined;
}

function hasAncestor(
  element: Element,
  items: ReadonlyMap<Element, unknown>,
  panel: HTMLElement,
): boolean {
  for (
    let current = element.parentElement;
    current && current !== panel;
    current = current.parentElement
  )
    if (items.has(current)) return true;
  return false;
}

function union(a: DOMRect, b: DOMRect): DOMRect {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  return new DOMRect(
    left,
    top,
    Math.max(a.right, b.right) - left,
    Math.max(a.bottom, b.bottom) - top,
  );
}

function intersect(
  rect: DOMRect,
  bounds: readonly DOMRect[],
): DOMRect | undefined {
  let { left, top, right, bottom } = rect;
  for (const bound of bounds) {
    left = Math.max(left, bound.left);
    top = Math.max(top, bound.top);
    right = Math.min(right, bound.right);
    bottom = Math.min(bottom, bound.bottom);
  }
  return right > left && bottom > top
    ? new DOMRect(left, top, right - left, bottom - top)
    : undefined;
}
