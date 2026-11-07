import type { HTMLAttributes, ReactNode } from "react";

/** Palette chrome shared by the real palette and the tutorial's component preview. */
export function PaletteSurface({
  input,
  children,
  variant,
  ...semantics
}: {
  input: ReactNode;
  children: ReactNode;
  variant?: "overlay" | "tab";
} & Pick<HTMLAttributes<HTMLDivElement>, "role" | "aria-label">) {
  return (
    <div
      {...semantics}
      data-palette={variant}
      className="pointer-events-auto flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-bg-raised shadow-2xl"
    >
      <div className="mx-3 flex items-start gap-2 border-b border-border">
        {input}
      </div>
      {children}
    </div>
  );
}
