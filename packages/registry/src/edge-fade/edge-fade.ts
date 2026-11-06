/** How near an end a list counts as there (sub-pixel scroll positions). */
const SLACK = 1;

/**
 * How far in from an edge of a faded scroller the fade reaches (0 for one
 * that does not fade): where a jump by `scrollTo` should leave its target,
 * as scroll padding does for focus and `scrollIntoView`.
 */
export function edgeFadeLength(scroller: HTMLElement): number {
  return scroller.classList.contains("cat-edge-fade")
    ? Number.parseFloat(
        getComputedStyle(scroller).getPropertyValue("--cat-edge-fade"),
      ) || 0
    : 0;
}

/**
 * Fades a scroller's content out where it continues past its top or bottom,
 * instead of cutting it there. The `cat-edge-fade` class
 * (`@catamorphic/ui/styles.css`) draws the mask from two lengths this keeps
 * on the scroller: `--cat-edge-fade-top` and `--cat-edge-fade-bottom`, how
 * far the content goes on past each edge, up to the fade's own length
 * (`--cat-edge-fade`). An edge is sharp at that end of the list and fades
 * fully a fade's length in, following the scroll as it goes. The mask
 * applies only while an edge fades (`data-edge-faded`).
 *
 * What moves an edge is a scroll, the scroller's own size, motion inside
 * it settling, and, for the bottom, the content's end: a marker one fade tall laid over the content's
 * last stretch (kept last), whose share in view an intersection observer
 * reads pixel by pixel. Observing the content's size instead would put a
 * box above the content's own observers into every resize pass, and a
 * collapsible inside that writes its height from its observer (a sidebar
 * section) would then make Chromium report an undelivered-notification
 * loop. No animation runs, so nothing that waits for motion to end
 * (`getAnimations()`) waits on a list, and it costs nothing at rest.
 *
 * The scroller lays its content out as blocks (the marker follows it), and
 * its own size may follow its content only outside resize observer
 * callbacks. Without observers (a test DOM, a server) it does nothing.
 * Returns its cleanup.
 */
export function fadeEdges(scroller: HTMLElement): () => void {
  if (
    typeof IntersectionObserver === "undefined" ||
    typeof ResizeObserver === "undefined" ||
    // Faded already: two would trade the last place forever.
    scroller.querySelector(":scope > [data-edge-fade-end]")
  )
    return () => {};
  const fade =
    Number.parseFloat(
      getComputedStyle(scroller).getPropertyValue("--cat-edge-fade"),
    ) || 24;
  let top = -1;
  let bottom = -1;
  let faded = false;
  const length = (beyond: number) =>
    beyond <= SLACK ? 0 : Math.min(fade, Math.round(beyond));
  const update = () => {
    const above = length(scroller.scrollTop);
    const below = length(
      scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
    );
    if (above !== top) {
      top = above;
      scroller.style.setProperty("--cat-edge-fade-top", `${above}px`);
    }
    if (below !== bottom) {
      bottom = below;
      scroller.style.setProperty("--cat-edge-fade-bottom", `${below}px`);
    }
    // Masked only while an edge fades: a mask costs the compositor a pass.
    if (faded !== (above > 0 || below > 0)) {
      faded = !faded;
      scroller.toggleAttribute("data-edge-faded", faded);
    }
  };
  const end = document.createElement("div");
  end.setAttribute("aria-hidden", "true");
  end.dataset.edgeFadeEnd = "";
  // Over the content's last stretch: it adds no height.
  end.style.cssText = `display:block;height:${fade}px;margin:-${fade}px 0 0;padding:0;border:0;visibility:hidden;overflow-anchor:none;pointer-events:none`;
  const keepLast = () => {
    if (scroller.lastChild !== end) scroller.append(end);
  };
  keepLast();
  const children = new MutationObserver(keepLast);
  children.observe(scroller, { childList: true });
  const steps = Math.max(1, Math.round(fade));
  const near = new IntersectionObserver(update, {
    root: scroller,
    threshold: Array.from({ length: steps + 1 }, (_, step) => step / steps),
  });
  near.observe(end);
  const size = new ResizeObserver(update);
  size.observe(scroller);
  scroller.addEventListener("scroll", update, { passive: true });
  // A row sliding to its place, or in or out, can reach past the end for a
  // moment without moving the end itself: read again once motion settles.
  const settled = ["transitionend", "transitioncancel", "animationend"];
  for (const name of settled) scroller.addEventListener(name, update);
  return () => {
    scroller.removeEventListener("scroll", update);
    for (const name of settled) scroller.removeEventListener(name, update);
    size.disconnect();
    near.disconnect();
    children.disconnect();
    end.remove();
    scroller.style.removeProperty("--cat-edge-fade-top");
    scroller.style.removeProperty("--cat-edge-fade-bottom");
    scroller.removeAttribute("data-edge-faded");
  };
}
