import type { SidebarStatus } from "./sidebar-contribution.js";

/** Three quiet placeholder rows shown before a section's first result. */
export function SidebarSkeleton() {
  return (
    <div aria-hidden="true" className="sidebar-skeleton">
      {[62, 84, 48].map((width) => (
        <div key={width} className="sidebar-skeleton-row">
          <span className="sidebar-skeleton-icon" />
          <span
            className="sidebar-skeleton-bar"
            style={{ width: `${width}%` }}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * The one status presentation every sidebar section shares: skeleton rows
 * while loading, a muted sentence when empty, the error with Retry when a
 * read failed. Ready and refreshing draw nothing here; the header spinner
 * covers refreshing while the rows stay on screen.
 */
export function SidebarStatusBody({
  status,
  empty,
  retry,
}: {
  status: SidebarStatus;
  empty?: string;
  retry?: () => unknown;
}) {
  if (status.state === "loading") return <SidebarSkeleton />;
  if (status.state === "error")
    return (
      <div role="alert" className="sidebar-empty-state">
        <p className="break-words">
          {status.error ?? "Could not load this section."}
        </p>
        {retry && (
          <button
            type="button"
            className="mt-1 cursor-pointer text-accent"
            onClick={() => void retry()}
          >
            Retry
          </button>
        )}
      </div>
    );
  if (status.state === "empty")
    return (
      <p className="sidebar-empty-state">
        {empty ?? status.empty ?? "Nothing here yet."}
      </p>
    );
  return null;
}
