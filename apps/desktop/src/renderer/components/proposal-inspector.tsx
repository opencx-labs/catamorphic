import { useQuery } from "@tanstack/react-query";
import { GitPullRequest } from "lucide-react";
import { useState } from "react";
import type { PrDecisionInput, PrDetails } from "../../shared/pr-details.js";
import { desktopApi, type PullRequestSummary } from "../lib/desktop-api.js";
import { ResourceInspector } from "./resource-inspector.js";
import { ReviewMetadata } from "./review-metadata.js";

export function ProposalInspector({
  projectId,
  proposal,
  details,
  onChanged,
}: {
  projectId: string;
  proposal: PullRequestSummary;
  details: PrDetails | null;
  onChanged: () => void;
}) {
  const access = useQuery({
    queryKey: ["proposal-review-access", projectId],
    queryFn: () => desktopApi.remoteStatus(projectId),
  });
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const builder =
    access.isSuccess &&
    (!access.data || access.data.capabilities?.builder === true);
  const decide = async (decision: PrDecisionInput["decision"]) => {
    if (!proposal.headSha) return;
    setPending(true);
    setError(null);
    try {
      await desktopApi.prDecision({
        projectId,
        number: proposal.number,
        headSha: proposal.headSha,
        decision,
        body,
      });
      setResult(
        decision === "apply"
          ? "Applied to the project repository"
          : decision === "approve"
            ? "Approved"
            : "Changes requested",
      );
      setBody("");
      if (decision !== "apply") onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  const actionClass =
    "w-full cursor-pointer rounded-md px-2 py-1.5 text-left text-[11px] text-fg-muted hover:bg-bg-overlay hover:text-fg disabled:cursor-not-allowed disabled:opacity-50";
  return (
    <ResourceInspector
      label="Proposal status and actions"
      pinOnClick
      content={
        <>
          <header className="border-b border-border pb-3">
            <h2 className="text-[13px] font-semibold text-fg">
              {proposal.title}
            </h2>
            <p className="mt-1 text-[11px] text-fg-muted">
              Proposal #{proposal.number}
            </p>
          </header>
          {details ? (
            <div className="py-3">
              <ReviewMetadata
                details={
                  result === "Applied to the project repository"
                    ? { ...details, state: "MERGED" }
                    : details
                }
                label="Review status and people"
                company={Boolean(access.data)}
              />
            </div>
          ) : (
            <p className="py-3 text-[11px] text-fg-muted">Awaiting review</p>
          )}
          {builder &&
            details?.state.toUpperCase() === "OPEN" &&
            result !== "Applied to the project repository" && (
              <div className="border-t border-border pt-2">
                <label className="flex flex-col gap-1 text-[11px] text-fg-muted">
                  Review note
                  <textarea
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                    rows={3}
                    className="field resize-none p-2 text-fg"
                  />
                </label>
                <button
                  type="button"
                  className={actionClass}
                  disabled={pending || !proposal.headSha}
                  onClick={() => void decide("approve")}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className={actionClass}
                  disabled={pending || !proposal.headSha || !body.trim()}
                  onClick={() => void decide("request-changes")}
                >
                  Request changes
                </button>
                <button
                  type="button"
                  className={actionClass}
                  disabled={pending || !proposal.headSha || proposal.draft}
                  onClick={() => void decide("apply")}
                >
                  Apply to project
                </button>
                <p className="px-2 py-1 text-[10px] leading-4 text-fg-faint">
                  Applying shares this version with the project. The project’s
                  approval rules and checks still apply.
                </p>
              </div>
            )}
          {pending && (
            <p role="status" className="mt-2 text-[11px] text-fg-muted">
              Updating proposal…
            </p>
          )}
          {result && (
            <p role="status" className="mt-2 text-[11px] text-accent">
              {result}
            </p>
          )}
          {error && (
            <p role="alert" className="mt-2 text-[11px] text-danger">
              {error}
            </p>
          )}
        </>
      }
    >
      {(triggerProps) => (
        <button
          {...triggerProps}
          type="button"
          data-testid="proposal-inspector-trigger"
          aria-label="Proposal status and actions"
          className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-fg-muted hover:bg-bg-overlay hover:text-fg"
        >
          <GitPullRequest className="size-3.5 text-accent" />
          {result ??
            (details?.state.toUpperCase() === "MERGED"
              ? "Applied"
              : details?.state.toUpperCase() === "CLOSED"
                ? "Closed"
                : "Review")}
        </button>
      )}
    </ResourceInspector>
  );
}
