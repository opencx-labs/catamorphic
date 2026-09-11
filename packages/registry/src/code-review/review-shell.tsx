import { type ReactNode, useRef } from "react";
import { ReviewStyles } from "./review-styles.js";

export type ReviewView = "overview" | "guide" | "diff" | "discussion";
const views: readonly { value: ReviewView; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "guide", label: "Guide" },
  { value: "diff", label: "Changes" },
  { value: "discussion", label: "Discussion" },
];

/** Osama's review navigation, shared by the desktop and generated apps. */
export function ReviewNavigation({
  value,
  onChange,
}: {
  value: ReviewView;
  onChange: (view: ReviewView) => void;
}) {
  const nav = useRef<HTMLElement>(null);
  return (
    <nav ref={nav} aria-label="Review view" className="cat-review-nav">
      <ReviewStyles />
      {views.map((view, index) => (
        <button
          key={view.value}
          type="button"
          aria-current={value === view.value ? "page" : undefined}
          onClick={() => onChange(view.value)}
          onKeyDown={(event) => {
            const next =
              event.key === "ArrowRight"
                ? (index + 1) % views.length
                : event.key === "ArrowLeft"
                  ? (index + views.length - 1) % views.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? views.length - 1
                      : undefined;
            if (next === undefined) return;
            event.preventDefault();
            nav.current?.querySelectorAll("button")[next]?.focus();
            const target = views[next];
            if (target) onChange(target.value);
          }}
        >
          {view.label}
        </button>
      ))}
    </nav>
  );
}

/** Compose individual review content within a familiar, controlled frame. */
export function ReviewShell({
  title,
  subtitle,
  value,
  onChange,
  overview,
  guide,
  changes,
  discussion,
  stale = false,
  actions,
}: {
  title: string;
  subtitle?: string;
  value: ReviewView;
  onChange: (view: ReviewView) => void;
  overview: ReactNode;
  guide: ReactNode;
  changes: ReactNode;
  discussion?: ReactNode;
  stale?: boolean;
  actions?: ReactNode;
}) {
  const content = {
    overview,
    guide,
    diff: changes,
    discussion: discussion ?? <p>No discussion was captured in this review.</p>,
  };
  return (
    <section className="cat-review" aria-label={title}>
      <ReviewStyles />
      <header className="cat-review-heading">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {actions}
      </header>
      <ReviewNavigation value={value} onChange={onChange} />
      {stale && (
        <p className="cat-review-stale" role="status">
          The changes have updated since this review was generated.
        </p>
      )}
      <div className="cat-review-body" data-view={value}>
        {content[value]}
      </div>
    </section>
  );
}

export interface ReviewSourceLocation {
  file: string;
  revision: string;
  line: number;
  side: "additions" | "deletions";
}

export function ReviewFinding({
  title,
  source,
  children,
  onOpenSource,
}: {
  title: string;
  source: ReviewSourceLocation;
  children: ReactNode;
  onOpenSource?: (source: ReviewSourceLocation) => void;
}) {
  return (
    <details className="cat-review-finding" open>
      <ReviewStyles />
      <summary>{title}</summary>
      <div>{children}</div>
      {onOpenSource ? (
        <button
          type="button"
          className="cat-review-control cat-review-evidence"
          onClick={() => onOpenSource(source)}
        >
          {source.file}:{source.line} · {source.revision.slice(0, 12)}
        </button>
      ) : (
        <p className="cat-review-evidence">
          {source.file}:{source.line} · {source.revision.slice(0, 12)}
        </p>
      )}
    </details>
  );
}
