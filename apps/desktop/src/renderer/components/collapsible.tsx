import type { ReactNode } from "react";

/** The sidebar's structural motion, shared by every nesting level. */
export function Collapsible({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="grid transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none"
      style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
      inert={!open}
      aria-hidden={!open}
      data-collapsible={open ? "open" : "closed"}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
