import type { ReactNode } from "react";

/**
 * The host's structural collapse: a grid row that tweens between 0fr and
 * 1fr with the standard curve, so neighbours slide instead of jumping.
 * Closed content is inert and hidden from assistive tech but stays
 * mounted, which keeps form state and scroll positions.
 */
export function Collapsible({
  open,
  children,
  className,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={className ? `cat-collapsible ${className}` : "cat-collapsible"}
      data-state={open ? "open" : "closed"}
      inert={!open}
      aria-hidden={!open}
    >
      <div className="cat-collapsible-inner">{children}</div>
    </div>
  );
}
