import {
  type ComponentProps,
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
  layoutRef,
  minWidth = 360,
  maxHeight,
  onExited,
  ...attributes
}: Omit<
  ComponentProps<"div">,
  "className" | "children" | "ref" | "onAnimationEnd"
> & {
  open: boolean;
  className: string;
  testId?: string;
  children: ReactNode;
  anchorRef?: RefObject<HTMLElement | null>;
  /** Layout that can move the anchor without resizing it. */
  layoutRef?: RefObject<HTMLElement | null>;
  minWidth?: number;
  maxHeight?: number;
  /** The exit has played and the panel has left the page. */
  onExited?: () => void;
}) {
  const [mounted, setMounted] = useState(open);
  const panelRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const anchor = anchorRef?.current;
    if (!mounted || !open || !panel || !anchor) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(
        Math.max(rect.width, minWidth),
        window.innerWidth - 16,
      );
      Object.assign(panel.style, {
        position: "fixed",
        zIndex: "120",
        margin: "0",
        top: "auto",
        right: "auto",
        width: `${width}px`,
        left: `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`,
        bottom: `${Math.max(8, window.innerHeight - rect.top + 8)}px`,
        maxHeight: `${Math.min(maxHeight ?? Infinity, Math.max(100, rect.top - 16))}px`,
      });
    };
    place();
    const layout = layoutRef?.current;
    let frame: number | undefined;
    const track = () => {
      frame = undefined;
      place();
      if (
        layout
          ?.getAnimations({ subtree: true })
          .some(
            (animation) =>
              animation.playState === "running" &&
              animation.effect?.getTiming().iterations !== Infinity,
          )
      )
        frame = requestAnimationFrame(track);
    };
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(track);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(anchor);
    if (layout) observer.observe(layout);
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => !panel.contains(record.target))) schedule();
    });
    if (layout)
      mutations.observe(layout, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["style", "class"],
      });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [mounted, open, anchorRef, layoutRef, minWidth, maxHeight]);
  const frozenRef = useRef<ReactNode>(children);
  if (open) frozenRef.current = children;
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  if (!mounted) return null;
  return (
    <div
      {...attributes}
      ref={panelRef}
      data-testid={testId}
      inert={!open}
      onAnimationEnd={(event) => {
        if (event.animationName !== "pop-out" || open) return;
        setMounted(false);
        onExited?.();
      }}
      className={`${className} ${open ? "animate-pop-in" : "animate-pop-out"}`}
    >
      {open ? children : frozenRef.current}
    </div>
  );
}
