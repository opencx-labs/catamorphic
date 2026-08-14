import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef } from "react";
import { cx } from "./cx.js";

type Edge = "top" | "bottom" | "left" | "right";
const EDGES: Edge[] = ["top", "bottom", "left", "right"];

/**
 * Scroll container that fades content at any edge with more to see. The
 * four fade overlays are persistent, `aria-hidden`, `pointer-events: none`
 * elements whose opacity toggles (200ms) — never mounted/unmounted, so
 * scrolling can't jank on element churn. One ResizeObserver plus a scroll
 * listener, cleaned up through a single AbortController.
 *
 * The gradient must match the surface BEHIND the content — pass `fadeColor`
 * when the container doesn't sit on `--color-bg-raised` (the default).
 */
export function ScrollHint({
  children,
  className,
  viewportClassName,
  fadeColor,
  style,
}: {
  children: ReactNode;
  /** Class for the outer wrapper (size it here: height/max-height). */
  className?: string;
  /** Class for the inner scrollable viewport. */
  viewportClassName?: string;
  /** CSS color behind the content; defaults to `var(--color-bg-raised)`. */
  fadeColor?: string;
  style?: CSSProperties;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const fadeRefs = useRef<Partial<Record<Edge, HTMLDivElement | null>>>({});

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => {
      const slack = 1; // sub-pixel scroll positions
      const canUp = viewport.scrollTop > slack;
      const canDown =
        viewport.scrollTop + viewport.clientHeight <
        viewport.scrollHeight - slack;
      const canLeft = viewport.scrollLeft > slack;
      const canRight =
        viewport.scrollLeft + viewport.clientWidth <
        viewport.scrollWidth - slack;
      const visible: Record<Edge, boolean> = {
        top: canUp,
        bottom: canDown,
        left: canLeft,
        right: canRight,
      };
      for (const edge of EDGES) {
        fadeRefs.current[edge]?.setAttribute(
          "data-visible",
          visible[edge] ? "true" : "false",
        );
      }
    };
    const controller = new AbortController();
    viewport.addEventListener("scroll", update, {
      signal: controller.signal,
      passive: true,
    });
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    controller.signal.addEventListener("abort", () => observer.disconnect());
    update();
    return () => controller.abort();
  }, []);

  return (
    <div
      className={cx("cat-scrollhint", className)}
      style={
        fadeColor
          ? ({ "--cat-fade-color": fadeColor, ...style } as CSSProperties)
          : style
      }
    >
      <div
        ref={viewportRef}
        className={cx("cat-scrollhint-viewport", viewportClassName)}
      >
        {children}
      </div>
      {EDGES.map((edge) => (
        <div
          key={edge}
          ref={(node) => {
            fadeRefs.current[edge] = node;
          }}
          className="cat-scrollhint-fade"
          data-edge={edge}
          data-visible="false"
          aria-hidden="true"
        />
      ))}
    </div>
  );
}
