import { ReviewMarkdown } from "./review-markdown.js";

export { ReviewMarkdown } from "./review-markdown.js";

import { useEffect, useRef, useState } from "react";
import type { PrDetails } from "../../shared/pr-details.js";
import { ReviewCommentComposer } from "./review-comment-composer.js";

export function latestReviews(reviews: PrDetails["reviews"]) {
  const byReviewer = new Map<string, PrDetails["reviews"][number]>();
  for (const [index, review] of reviews.entries()) {
    const key =
      review.author?.login?.toLowerCase() ?? `unknown:${review.id ?? index}`;
    const previous = byReviewer.get(key);
    const time = review.submittedAt ?? review.createdAt ?? "";
    const previousTime = previous?.submittedAt ?? previous?.createdAt ?? "";
    if (!previous || time >= previousTime) byReviewer.set(key, review);
  }
  return [...byReviewer.values()];
}

function checkPriority(status: string) {
  if (
    [
      "FAILURE",
      "ERROR",
      "TIMED_OUT",
      "CANCELLED",
      "ACTION_REQUIRED",
      "STARTUP_FAILURE",
    ].includes(status)
  )
    return 0;
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(status)) return 2;
  return 1;
}

export function orderedChecks(details: PrDetails) {
  return [...(details.statusCheckRollup ?? [])].sort(
    (a, b) =>
      checkPriority(a.conclusion || a.state || a.status || "PENDING") -
      checkPriority(b.conclusion || b.state || b.status || "PENDING"),
  );
}

export function ReviewMetadata({
  details,
  label = "Pull request details",
}: {
  details: PrDetails;
  label?: string;
}) {
  const checks = orderedChecks(details);
  const reviewers = latestReviews(details.reviews);
  return (
    <aside
      className="sticky top-0 flex h-fit min-w-0 flex-col gap-5 text-xs"
      aria-label={label}
    >
      <section>
        <h2 className="mb-2 font-medium text-fg-muted">Review status</h2>
        <p>
          {details.reviewDecision?.replaceAll("_", " ").toLowerCase() ||
            "Awaiting review"}
        </p>
      </section>
      <section>
        <h2 className="mb-2 font-medium text-fg-muted">Requested reviewers</h2>
        {details.reviewRequests.length ? (
          details.reviewRequests.map((person, index) => (
            <p key={person.login ?? person.name ?? index} className="py-1">
              {person.login ?? person.name ?? "Team reviewer"}
            </p>
          ))
        ) : (
          <p className="text-fg-faint">No reviewers requested</p>
        )}
      </section>
      <section>
        <h2 className="mb-2 font-medium text-fg-muted">Assignees</h2>
        {details.assignees.length ? (
          details.assignees.map((person, index) => (
            <p key={person.login ?? index}>{person.login ?? person.name}</p>
          ))
        ) : (
          <p className="text-fg-faint">Unassigned</p>
        )}
      </section>
      <section>
        <h2 className="mb-2 font-medium text-fg-muted">
          Latest reviews · {reviewers.length}
        </h2>
        <div className="max-h-48 overflow-auto">
          {reviewers.map((review, index) => (
            <div
              key={String(review.id ?? index)}
              className="flex justify-between gap-2 py-1"
            >
              <p>{review.author?.login ?? "Reviewer"}</p>
              <p className="text-fg-muted">
                {review.state?.replaceAll("_", " ").toLowerCase()}
              </p>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h2 className="mb-2 font-medium text-fg-muted">
          CI checks ·{" "}
          {checks.filter((c) => (c.conclusion ?? c.state) === "SUCCESS").length}
          /{checks.length} passed
        </h2>
        {checks.length ? (
          <div className="max-h-80 overflow-auto">
            {checks.map((check) => {
              const status =
                check.conclusion || check.state || check.status || "Pending";
              return (
                <a
                  key={
                    check.detailsUrl ??
                    check.targetUrl ??
                    check.name ??
                    check.context
                  }
                  href={check.detailsUrl || check.targetUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-w-0 items-start justify-between gap-3 rounded py-1.5 hover:bg-bg-overlay"
                >
                  <p className="min-w-0 flex-1 break-words">
                    {check.name ?? check.context ?? "Check"}
                  </p>
                  <p
                    className={
                      status === "SUCCESS"
                        ? "text-success"
                        : ["FAILURE", "ERROR", "TIMED_OUT"].includes(status)
                          ? "text-danger"
                          : "text-fg-muted"
                    }
                  >
                    {status.toLowerCase().replaceAll("_", " ")}
                  </p>
                </a>
              );
            })}
          </div>
        ) : (
          <p className="text-fg-faint">No checks reported</p>
        )}
      </section>
    </aside>
  );
}

function CommentBody({ body }: { body: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = body.length > 1200 || body.split("\n").length > 18;
  return (
    <div>
      <div
        className={
          !expanded && long
            ? "max-h-48 overflow-hidden [mask-image:linear-gradient(black_65%,transparent)]"
            : ""
        }
      >
        <ReviewMarkdown body={body} />
      </div>
      {long && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="mt-2 rounded px-2 py-1 text-xs font-medium text-fg-muted hover:bg-bg-overlay hover:text-fg"
        >
          {expanded ? "Show less" : "Read full comment"}
        </button>
      )}
    </div>
  );
}

export function discussionThreads(details: PrDetails) {
  const all = [
    ...details.comments,
    ...details.inlineComments,
    ...details.reviews.filter((review) => review.body.trim()),
  ];
  const ids = new Set(details.inlineComments.map((comment) => comment.id));
  return all
    .filter((comment) => !comment.replyToId || !ids.has(comment.replyToId))
    .sort((a, b) =>
      (a.createdAt ?? a.submittedAt ?? "").localeCompare(
        b.createdAt ?? b.submittedAt ?? "",
      ),
    )
    .map((comment) => ({
      comment,
      replies: details.inlineComments
        .filter(
          (reply) => reply.replyToId === comment.id && comment.id !== undefined,
        )
        .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "")),
    }));
}

function CommentIdentity({
  comment,
  reply = false,
}: {
  comment: PrDetails["comments"][number];
  reply?: boolean;
}) {
  const timestamp = comment.createdAt ?? comment.submittedAt;
  return (
    <header className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span
        aria-hidden="true"
        className="grid size-6 shrink-0 place-items-center rounded-full bg-bg-overlay text-[10px] font-medium"
      >
        {(comment.author?.login ?? "GH").slice(0, 2).toUpperCase()}
      </span>
      <span className="font-medium">{comment.author?.login ?? "GitHub"}</span>
      <span className="text-fg-muted">
        {reply
          ? "replied"
          : comment.state?.replaceAll("_", " ").toLowerCase() || "commented"}
      </span>
      {timestamp && (
        <time className="text-fg-faint" dateTime={timestamp}>
          {new Date(timestamp).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </time>
      )}
      {comment.url && (
        <a
          href={comment.url}
          target="_blank"
          rel="noreferrer"
          className="ml-auto text-fg-faint hover:text-fg"
        >
          View on GitHub
        </a>
      )}
    </header>
  );
}

export function ReviewDiscussion({
  details,
  url,
  onOpenFile,
  focusedPath,
  onClearPath,
  onPostComment,
  draftKey = "review-comment",
  submitShortcut,
}: {
  details: PrDetails;
  url?: string;
  onOpenFile?: (path: string, line?: number, side?: "LEFT" | "RIGHT") => void;
  focusedPath?: string;
  onClearPath?: () => void;
  onPostComment?: (input: {
    body: string;
    replyTo?: number;
  }) => Promise<PrDetails["comments"][number]>;
  draftKey?: string;
  submitShortcut?: { binding: string; label: string };
}) {
  const threadArea = useRef<HTMLElement>(null);
  const [revealId, setRevealId] = useState<string | null>(null);
  useEffect(() => {
    if (!revealId) return;
    const posted = [
      ...(threadArea.current?.querySelectorAll<HTMLElement>(
        "[data-comment-id]",
      ) ?? []),
    ].find((element) => element.dataset.commentId === revealId);
    if (posted) {
      posted.scrollIntoView({ block: "nearest" });
      setRevealId(null);
    }
  }, [revealId]);
  const postComment = async (input: { body: string; replyTo?: number }) => {
    if (!onPostComment) return;
    const posted = await onPostComment(input);
    if (posted.id !== undefined) setRevealId(String(posted.id));
  };
  const [replyingTo, setReplyingTo] = useState<number | null>(null);
  const threads = discussionThreads(details).filter(
    (thread) => !focusedPath || thread.comment.path === focusedPath,
  );
  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-6 py-4">
        <h2 className="text-sm font-medium">Discussion · {threads.length}</h2>
        {url && (
          <a
            className="text-xs text-fg-muted hover:text-fg"
            href={`${url}#issuecomment-new`}
            target="_blank"
            rel="noreferrer"
          >
            Open on GitHub
          </a>
        )}
      </header>
      {focusedPath && (
        <div className="flex min-w-0 shrink-0 items-center gap-3 bg-bg-overlay px-6 py-2 text-xs">
          <span className="min-w-0 flex-1 truncate font-mono">
            {focusedPath}
          </span>
          <button
            type="button"
            onClick={onClearPath}
            className="shrink-0 text-fg-muted hover:text-fg"
          >
            Show all discussions
          </button>
        </div>
      )}
      <section
        ref={threadArea}
        className="min-h-0 flex-1 overflow-auto px-6 py-5"
        aria-label="Comment threads"
      >
        {details.inlineCommentsUnavailable && (
          <p role="status" className="mb-4 text-sm text-warning">
            Inline comments could not load. Refresh to retry.
          </p>
        )}
        {!threads.length && (
          <p className="py-6 text-sm text-fg-muted">
            No comments yet. Start the conversation below.
          </p>
        )}
        <div className="flex flex-col gap-5">
          {threads.map(({ comment, replies }, index) => (
            <article
              key={String(comment.id ?? index)}
              data-comment-id={comment.id}
              className="min-w-0 overflow-hidden rounded-lg border border-border bg-bg-raised"
            >
              {comment.path && (
                <div className="border-b border-border bg-bg-overlay/40">
                  <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-xs">
                    <span className="min-w-0 break-all font-mono text-fg-muted">
                      {comment.path}
                      {comment.line ? `:${comment.line}` : " · outdated"}
                    </span>
                    {onOpenFile && (
                      <button
                        type="button"
                        onClick={() =>
                          comment.path &&
                          onOpenFile(
                            comment.path,
                            comment.line ?? undefined,
                            comment.side,
                          )
                        }
                        className="shrink-0 rounded px-1 py-1 text-fg-muted hover:text-fg"
                      >
                        Open file in Changes
                      </button>
                    )}
                  </div>
                  {comment.diffHunk && (
                    <pre className="max-h-44 overflow-auto border-t border-border py-2 text-[11px] leading-5">
                      {comment.diffHunk
                        .split("\n")
                        .slice(-8)
                        .map((line, lineIndex) => (
                          <span
                            // biome-ignore lint/suspicious/noArrayIndexKey: Immutable diff excerpt; line positions disambiguate identical source lines.
                            key={`${lineIndex}:${line}`}
                            className={`block px-4 ${line.startsWith("+") ? "bg-success/10 text-success" : line.startsWith("-") ? "bg-danger/10 text-danger" : "text-fg-muted"}`}
                          >
                            {line || " "}
                          </span>
                        ))}
                    </pre>
                  )}
                </div>
              )}
              <div className="p-4">
                <CommentIdentity comment={comment} />
                <div className="pl-8">
                  <CommentBody body={comment.body} />
                </div>
              </div>
              {replies.map((reply) => (
                <section
                  key={reply.id}
                  data-comment-id={reply.id}
                  className="min-w-0 border-t border-border px-4 py-3"
                >
                  <CommentIdentity comment={reply} reply />
                  <div className="pl-8">
                    <CommentBody body={reply.body} />
                  </div>
                </section>
              ))}
              {comment.path &&
                typeof comment.id === "number" &&
                onPostComment && (
                  <div className="border-t border-border px-4 py-3">
                    {replyingTo === comment.id ? (
                      <ReviewCommentComposer
                        shortcut={submitShortcut}
                        draftKey={`${draftKey}:reply:${comment.id}`}
                        reply
                        onPost={(body) =>
                          postComment({
                            body,
                            replyTo:
                              typeof comment.id === "number"
                                ? comment.id
                                : undefined,
                          })
                        }
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          typeof comment.id === "number" &&
                          setReplyingTo(comment.id)
                        }
                        className="w-full rounded-md border border-border bg-bg px-3 py-2 text-left text-sm text-fg-faint hover:border-border-strong hover:text-fg-muted"
                      >
                        Leave a reply…
                      </button>
                    )}
                  </div>
                )}
            </article>
          ))}
        </div>
      </section>
      {onPostComment && (
        <footer className="shrink-0 border-t border-border bg-bg px-6 pb-16 pt-3">
          <ReviewCommentComposer
            shortcut={submitShortcut}
            draftKey={`${draftKey}:new`}
            onPost={(body) => postComment({ body })}
          />
        </footer>
      )}
    </div>
  );
}
