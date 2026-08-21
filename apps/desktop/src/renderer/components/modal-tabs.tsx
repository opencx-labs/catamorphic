import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * Animates its height to follow the content's measured size, so swapping a
 * modal's tab (or mode) glides instead of snapping to a new height. Shared
 * by the project modal and the configure-agent modal.
 */
export function AnimatedHeight({ children }: { children: ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();

  useEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const observer = new ResizeObserver(() => setHeight(inner.offsetHeight));
    observer.observe(inner);
    setHeight(inner.offsetHeight);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      style={{ height }}
      className="overflow-hidden transition-[height] duration-200 ease-[cubic-bezier(0.2,0,0,1)]"
    >
      <div ref={innerRef}>{children}</div>
    </div>
  );
}

/**
 * One tab in a modal's `bg-bg-inset` tablist strip. The panel it controls
 * re-mounts with `key={tab}` + `animate-fade-in` (the sanctioned 200ms
 * mirror pair), usually inside {@link AnimatedHeight}.
 */
export function ModalTab({
  active,
  onSelect,
  icon,
  label,
  testId,
}: {
  active: boolean;
  onSelect: () => void;
  icon?: ReactNode;
  label: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      data-testid={testId}
      className={`flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-md text-[13px] transition-colors duration-150 ${
        active
          ? "bg-bg-overlay text-fg shadow-sm"
          : "text-fg-muted hover:text-fg"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
