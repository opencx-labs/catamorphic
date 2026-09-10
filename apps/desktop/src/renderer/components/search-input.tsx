import type { ComponentProps } from "react";

/** Input with a reserved shortcut slot. Hosts supply the current binding label. */
export function SearchInput({
  shortcut,
  className = "",
  ...props
}: ComponentProps<"input"> & { shortcut?: string }) {
  return (
    <div
      className={`field flex min-w-0 items-center gap-2 rounded-md px-2 py-1 ${className}`}
    >
      <input
        {...props}
        className="min-w-0 flex-1 bg-transparent text-xs outline-none"
      />
      {shortcut && (
        <kbd className="pointer-events-none shrink-0 whitespace-nowrap text-[10px] text-fg-faint">
          {shortcut}
        </kbd>
      )}
    </div>
  );
}
