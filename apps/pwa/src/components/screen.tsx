import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { goBack } from "../lib/nav.js";

/**
 * One screen of the navigation stack: safe-area-aware header (optional
 * back chevron, title, trailing control) over a content area that owns
 * its scrolling. The push/fade entrance class comes from the app shell.
 */
export function Screen({
  title,
  subtitle,
  back = false,
  trailing,
  children,
  animation = "",
}: {
  title: ReactNode;
  subtitle?: string;
  back?: boolean;
  trailing?: ReactNode;
  children: ReactNode;
  animation?: string;
}) {
  return (
    <div
      className={`flex h-full min-h-0 flex-col bg-bg ${animation}`}
      data-testid="screen"
    >
      <header className="pt-safe shrink-0 border-b border-border bg-bg-raised/95 backdrop-blur-xl">
        <div className="flex h-13 items-center gap-1 px-2">
          {back && (
            <button
              type="button"
              onClick={goBack}
              className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-lg text-fg-muted active:bg-bg-overlay"
              aria-label="Back"
              data-testid="screen-back"
            >
              <ChevronLeft className="size-5.5" />
            </button>
          )}
          <div className={`min-w-0 flex-1 ${back ? "" : "pl-2"}`}>
            <div className="truncate text-[16px] font-semibold leading-5">
              {title}
            </div>
            {subtitle && (
              <div className="truncate text-[11px] leading-4 text-fg-faint">
                {subtitle}
              </div>
            )}
          </div>
          {trailing && <div className="shrink-0 pr-1">{trailing}</div>}
        </div>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
