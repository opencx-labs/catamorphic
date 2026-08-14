/**
 * Indeterminate progress indicator — the one sanctioned looping animation
 * (alongside the Skeleton shimmer). Inherits `currentColor`, so it reads
 * correctly inside buttons, muted text, and accent fills alike.
 */
export function Spinner({
  size = 14,
  className,
  label,
}: {
  /** Diameter in px. Defaults to 14 (fits a 28px control). */
  size?: number;
  className?: string;
  /** Accessible name; omit when a neighboring label already describes the wait. */
  label?: string;
}) {
  return (
    <svg
      className={className ? `cat-spinner ${className}` : "cat-spinner"}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle
        cx="8"
        cy="8"
        r="6.5"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="1.5"
      />
      <path
        d="M14.5 8a6.5 6.5 0 0 0-6.5-6.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
