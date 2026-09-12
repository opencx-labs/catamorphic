import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export function PopPanel({
  open,
  className,
  testId,
  children,
  anchorRef,
}: {
  open: boolean;
  className: string;
  testId?: string;
  children: ReactNode;
  anchorRef?: RefObject<HTMLElement | null>;
}) {
  const [mounted, setMounted] = useState(open);
  const panelRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const anchor = anchorRef?.current;
    if (!mounted || !open || !panel || !anchor) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 360), window.innerWidth - 16);
      Object.assign(panel.style, {
        position: "fixed",
        margin: "0",
        top: "auto",
        right: "auto",
        width: `${width}px`,
        left: `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`,
        bottom: `${Math.max(8, window.innerHeight - rect.top + 8)}px`,
        maxHeight: `${Math.max(100, rect.top - 16)}px`,
      });
    };
    place();
    panel.showPopover();
    const observer = new ResizeObserver(place);
    observer.observe(anchor);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [mounted, open, anchorRef]);
  const frozenRef = useRef<ReactNode>(children);
  if (open) frozenRef.current = children;
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  if (!mounted) return null;
  return (
    <div
      ref={panelRef}
      popover={anchorRef ? "manual" : undefined}
      data-testid={testId}
      inert={!open}
      onAnimationEnd={(event) => {
        if (event.animationName === "pop-out" && !open) setMounted(false);
      }}
      className={`${className} ${open ? "animate-pop-in" : "animate-pop-out"}`}
    >
      {open ? children : frozenRef.current}
    </div>
  );
}
