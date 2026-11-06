import { type ReactNode, useEffect, useState } from "react";
import { Collapsible } from "./collapsible.js";

/**
 * A Collapsible that starts closing two frames after it is told to. What
 * closes it usually commits something heavier in the same frame (an
 * answered question's panel closing as the answer takes its place in the
 * conversation): a close that began in that long frame would show as a
 * jump. Its own re-render is all the later frame does, and opening is
 * immediate. What it holds is inert from the moment it is told to close:
 * a second press meanwhile reaches nothing.
 */
export function ClosingCollapsible({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  const [closed, setClosed] = useState(!open);
  useEffect(() => {
    if (open) {
      setClosed(false);
      return;
    }
    let second: number | undefined;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setClosed(true));
    });
    return () => {
      cancelAnimationFrame(first);
      if (second !== undefined) cancelAnimationFrame(second);
    };
  }, [open]);
  return (
    <Collapsible open={open || !closed}>
      <div inert={!open}>{children}</div>
    </Collapsible>
  );
}
