import type { CSSProperties } from "react";
import { cx } from "./cx.js";

/**
 * Loading placeholder with a persistent shimmer. It always renders its
 * shimmer — never a renders-nothing trap — so a screen in its loading state
 * visibly *is* loading. When the content arrives, swap it in immediately
 * (or with a crossfade of at most 150ms); never hold finished content
 * hostage waiting for a skeleton exit animation.
 */
export function Skeleton({
  width,
  height = 13,
  className,
  style,
}: {
  /** CSS width (number = px). Defaults to filling the container. */
  width?: number | string;
  /** CSS height (number = px). Defaults to one line of base text (13px). */
  height?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={cx("cat-skeleton", className)}
      style={{ display: "block", width, height, ...style }}
      aria-hidden="true"
    />
  );
}
