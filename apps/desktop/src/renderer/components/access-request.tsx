import { useState } from "react";
import type { ModuleAccessRequest } from "../../shared/code-access.js";

/**
 * What a module asks before it runs (ADR 0277), in Work's own words: only
 * what is new since the person last allowed it, the rest of what it would
 * reach when there is any, and one way to allow it. Code never draws
 * this, so it cannot word its own request.
 */
export function AccessRequest({
  request,
  allow,
  compact = false,
}: {
  request: ModuleAccessRequest;
  allow: () => Promise<void>;
  compact?: boolean;
}) {
  const [state, setState] = useState<"asking" | "allowing" | string>("asking");
  const already = request.all.filter((line) => !request.beyond.includes(line));
  return (
    <section
      aria-label={`${request.module} wants more access`}
      data-testid="module-access-request"
      className={compact ? "px-2 py-1 text-xs" : "sidebar-empty-state"}
    >
      <p className="font-medium text-fg">
        {already.length
          ? `${request.module} now also wants to`
          : `${request.module} wants to`}
      </p>
      <ul className="mt-1 space-y-0.5 text-fg-muted">
        {request.beyond.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {already.length > 0 && (
        <p className="mt-1 text-fg-faint">
          Already allowed: {already.join(", ")}.
        </p>
      )}
      {request.network && (
        <p className="mt-1 text-fg-faint">
          It can read this project's files and send them to these addresses.
        </p>
      )}
      <button
        type="button"
        data-testid="module-access-allow"
        className="mt-1.5 cursor-pointer text-accent disabled:cursor-default disabled:opacity-60"
        disabled={state === "allowing"}
        onClick={() => {
          setState("allowing");
          allow().then(
            () => setState("asking"),
            (cause: unknown) =>
              setState(cause instanceof Error ? cause.message : String(cause)),
          );
        }}
      >
        Allow
      </button>
      {state !== "asking" && state !== "allowing" && (
        <p role="alert" className="mt-1 break-words text-danger">
          {state}
        </p>
      )}
    </section>
  );
}
