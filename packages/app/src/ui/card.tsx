import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx.js";

/**
 * The kit's surface unit: raised background, 1px hairline border, large
 * radius, 16px padding. Compose screens from Cards on the app background —
 * hierarchy comes from surface steps and borders, not shadows.
 */
export function Card({
  title,
  description,
  footer,
  className,
  children,
  ...rest
}: {
  /** Optional header title (14px, semibold). */
  title?: ReactNode;
  /** Optional muted line under the title. */
  description?: ReactNode;
  /** Optional footer slot, separated by a hairline, actions right-aligned. */
  footer?: ReactNode;
  children?: ReactNode;
} & ComponentProps<"div">) {
  return (
    <div {...rest} className={cx("cat-card", className)}>
      {title != null || description != null ? (
        <div className="cat-card-header">
          {title != null ? <h2 className="cat-card-title">{title}</h2> : null}
          {description != null ? (
            <p className="cat-card-desc">{description}</p>
          ) : null}
        </div>
      ) : null}
      {children}
      {footer != null ? <div className="cat-card-footer">{footer}</div> : null}
    </div>
  );
}
