import { useEffect, useRef, useState } from "react";
import { matchesShortcut } from "../../shared/keybindings.js";
import { ReviewMarkdown } from "./review-markdown.js";

export function ReviewCommentComposer({
  draftKey,
  reply,
  onPost,
  shortcut,
}: {
  draftKey: string;
  reply?: boolean;
  shortcut?: { binding: string; label: string };
  onPost: (body: string) => Promise<void>;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (reply) input.current?.focus();
  }, [reply]);
  const [body, setBody] = useState(() => {
    try {
      return localStorage.getItem(draftKey) ?? "";
    } catch {
      return "";
    }
  });
  const [preview, setPreview] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const binding = shortcut?.binding ?? "";
  const submit = async () => {
    if (locked.current || !body.trim()) return;
    locked.current = true;
    setSending(true);
    setError("");
    try {
      await onPost(body.trim());
      setBody("");
      setPreview(false);
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* The posted draft remains in memory only. */
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not post. Your draft is preserved.",
      );
    } finally {
      locked.current = false;
      setSending(false);
    }
  };
  return (
    <form
      data-pr-comment
      aria-label={reply ? "Reply to code thread" : "New pull request comment"}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="rounded-lg border border-border bg-bg focus-within:border-border-strong"
    >
      {preview ? (
        <div className="max-h-48 min-h-20 overflow-auto p-3">
          <ReviewMarkdown body={body || "Nothing to preview."} />
        </div>
      ) : (
        <textarea
          ref={input}
          aria-label={reply ? "Reply" : "Comment"}
          placeholder={reply ? "Leave a reply…" : "Leave a comment…"}
          value={body}
          disabled={sending}
          maxLength={65536}
          rows={3}
          onChange={(event) => {
            setBody(event.target.value);
            try {
              localStorage.setItem(draftKey, event.target.value);
            } catch {
              setError(
                "Draft cannot be saved on this device. Keep this view open until you post.",
              );
            }
          }}
          onKeyDown={(event) => {
            if (
              matchesShortcut({
                event,
                binding,
                mac: /Mac/.test(navigator.platform),
              })
            ) {
              event.preventDefault();
              event.stopPropagation();
              void submit();
            }
          }}
          className="block max-h-48 min-h-20 w-full resize-y rounded-t-lg bg-transparent p-3 text-sm outline-none placeholder:text-fg-faint disabled:opacity-60"
        />
      )}
      {error && (
        <p role="alert" className="px-3 pb-2 text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-3 px-3 pb-2">
        <button
          type="button"
          onClick={() => setPreview(!preview)}
          className="rounded px-1 py-1 text-xs text-fg-muted hover:text-fg"
        >
          {preview ? "Write" : "Preview"}
        </button>
        <div className="flex items-center gap-3">
          <kbd className="text-[10px] text-fg-faint">
            {shortcut?.label || "Unbound"}
          </kbd>
          <button
            type="submit"
            disabled={sending || !body.trim()}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40"
          >
            {sending ? "Posting…" : reply ? "Reply" : "Comment"}
          </button>
        </div>
      </div>
    </form>
  );
}
