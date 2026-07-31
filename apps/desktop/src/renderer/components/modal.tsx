import { type ReactNode, useEffect, useRef } from "react";

export function Modal({
  open,
  onClose,
  children,
  width = 480,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Claim the key so the expanded chat's window listener ignores it.
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [open, onClose]);

  return (
    <div
      className={`fixed inset-0 z-[100] grid place-items-center transition-opacity duration-150 ease-[cubic-bezier(0.2,0,0,1)] ${
        open ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
      aria-hidden={!open}
      inert={!open ? true : undefined}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-away; Escape covers keyboard */}
      <div
        className="absolute inset-0 bg-black/50"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        style={{ width, maxWidth: "calc(100vw - 48px)" }}
        className={`relative rounded-xl border border-border bg-bg-raised shadow-2xl transition-transform duration-150 ease-[cubic-bezier(0.2,0,0,1)] ${
          open ? "scale-100" : "scale-95"
        }`}
      >
        {children}
      </div>
    </div>
  );
}
