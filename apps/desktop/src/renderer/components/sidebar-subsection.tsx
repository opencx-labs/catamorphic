import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Collapsible } from "./collapsible.js";

/**
 * A labelled group inside a section. It is nothing special: the same quiet
 * label every section uses for a sub-list, optionally collapsible with the
 * section chevron and motion. Omit the label for an unlabelled group.
 */
export function SidebarSubsection({
  label,
  collapsible = false,
  defaultOpen = true,
  children,
}: {
  label?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (!label) return <div className="flex flex-col gap-1">{children}</div>;
  const heading = (
    <span className="truncate text-xs font-medium text-fg-muted">{label}</span>
  );
  return (
    <div className="flex flex-col gap-1" data-sidebar-subsection={label}>
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex h-7 min-w-0 cursor-pointer items-center justify-between gap-2 rounded-md px-2 hover:text-fg"
        >
          {heading}
          <ChevronRight
            className={`size-3 shrink-0 text-fg-muted transition-transform duration-150 ease-[cubic-bezier(0.2,0,0,1)] ${
              open ? "rotate-90" : ""
            }`}
          />
        </button>
      ) : (
        <div className="flex h-7 items-center px-2">{heading}</div>
      )}
      {collapsible ? (
        <Collapsible open={open}>{children}</Collapsible>
      ) : (
        children
      )}
    </div>
  );
}
