import type { ReactNode } from "react";

/** Palette chrome shared by the real palette and the tutorial's component preview. */
export function PaletteSurface({
  input,
  children,
}: {
  input: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      role="dialog"
      aria-label="Command palette"
      className="pointer-events-auto flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-bg-raised shadow-2xl"
    >
      <div className="mx-3 flex items-start gap-2 border-b border-border">
        {input}
      </div>
      {children}
    </div>
  );
}
