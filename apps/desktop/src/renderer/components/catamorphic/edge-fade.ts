/** How near an end a list counts as there (sub-pixel scroll positions). */
const SLACK = 1;

/**
 * Fades a scroller's content out where it continues past its top or bottom,
 * instead of cutting it there. The `cat-edge-fade` class
 * (`@catamorphic/ui/styles.css`) draws the mask from two lengths this keeps
 * on the scroller: `--cat-edge-fade-top` and `--cat-edge-fade-bottom`, how
 * far the content goes on past each edge, up to the fade's own length
 * (`--cat-edge-fade`). An edge is sharp at that end of the list and fades
 * fully a fade's length in, following the scroll as it goes.
 *
 * What moves an edge is a scroll, the scroller's own size, and, for the
 * bottom, the content's end: a marker appended after the content (kept
 * last), which two intersection observers watch reach the bottom edge and
 * a fade's length past it. Observing the content's size instead would put
 * a box above the content's own observers into every resize pass, and a
 * collapsible inside that writes its height from its observer (a sidebar
 * section) would then make Chromium report an undelivered-notification
 * loop; so the scroller's own size must not follow its content. No
 * animation runs, so nothing that waits for motion to end
 * (`getAnimations()`) waits on a list, and it costs nothing at rest.
 * Returns its cleanup.
 */
export function fadeEdges(scroller: HTMLElement): () => void {
  const fade =
    Number.parseFloat(
      getComputedStyle(scroller).getPropertyValue("--cat-edge-fade"),
    ) || 24;
  let top = -1;
  let bottom = -1;
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
  };
  const end = document.createElement("div");
  end.setAttribute("aria-hidden", "true");
  end.dataset.edgeFadeEnd = "";
  end.style.cssText =
    "display:block;height:0;margin:0;padding:0;border:0;overflow-anchor:none;pointer-events:none";
  const keepLast = () => {
    if (scroller.lastChild !== end) scroller.append(end);
  };
  keepLast();
  const children = new MutationObserver(keepLast);
  children.observe(scroller, { childList: true });
  const reached = new IntersectionObserver(update, { root: scroller });
  const near = new IntersectionObserver(update, {
    root: scroller,
    rootMargin: `0px 0px ${fade}px 0px`,
  });
  reached.observe(end);
  near.observe(end);
  const size = new ResizeObserver(update);
  size.observe(scroller);
  scroller.addEventListener("scroll", update, { passive: true });
  return () => {
    scroller.removeEventListener("scroll", update);
    size.disconnect();
    reached.disconnect();
    near.disconnect();
    children.disconnect();
    end.remove();
    scroller.style.removeProperty("--cat-edge-fade-top");
    scroller.style.removeProperty("--cat-edge-fade-bottom");
  };
}
