import {
  Component,
  type ErrorInfo,
  type HTMLAttributes,
  type ReactNode,
} from "react";

interface SurfaceErrorBoundaryProps {
  label: string;
  children: ReactNode;
  onDismiss?: () => void;
  resetKey?: string | boolean;
  renderFallback?: (retry: () => void) => ReactNode;
}

/** Keeps a failed view's placement and its healthy siblings mounted. */
export class SurfaceErrorBoundary extends Component<
  SurfaceErrorBoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `[Work] Could not render ${this.props.label}`,
      error,
      info.componentStack,
    );
  }

  componentDidUpdate(previous: SurfaceErrorBoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey)
      this.retry();
  }

  private retry = () => this.setState({ failed: false });

  render() {
    if (!this.state.failed) return this.props.children;
    return this.props.renderFallback ? (
      this.props.renderFallback(this.retry)
    ) : (
      <SurfaceError
        label={this.props.label}
        onRetry={this.retry}
        onDismiss={this.props.onDismiss}
      />
    );
  }
}

export function SurfaceError({
  label,
  onRetry,
  onDismiss,
  dismissLabel = "Close tab",
}: {
  label: string;
  onRetry: () => void;
  onDismiss?: () => void;
  dismissLabel?: string;
}) {
  return (
    <div
      role="alert"
      data-surface-error
      className="pointer-events-auto flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto p-6 text-center"
    >
      <h2 className="text-sm font-medium text-fg">
        {label} could not be displayed
      </h2>
      <p className="text-xs text-fg-muted">Try again to reopen this view.</p>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onRetry} className="button-primary">
          Try again
        </button>
        {onDismiss && (
          <button type="button" onClick={onDismiss} className="button-ghost">
            {dismissLabel}
          </button>
        )}
      </div>
    </div>
  );
}

/** The pane owns geometry; its boundary replaces only the content. */
export function SurfacePane({
  label,
  onDismiss,
  children,
  ...attributes
}: HTMLAttributes<HTMLDivElement> & {
  label: string;
  onDismiss: () => void;
}) {
  return (
    <div {...attributes}>
      <SurfaceErrorBoundary label={label} onDismiss={onDismiss}>
        {children}
      </SurfaceErrorBoundary>
    </div>
  );
}
