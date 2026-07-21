import {
  type AgentMessage,
  useAgentSession,
  useCreateAgentSession,
  useSendAgentMessage,
} from "@catamorphic/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

/**
 * Chat panel backed by the playground's AI SDK coding agent. The agent runs on
 * the playground server and edits the project inside the Cloudflare dev
 * sandbox; changes land in the dev working copy as an uncommitted draft, so
 * after each turn the project file queries are refreshed.
 */
export function AgentChatPanel({ projectId }: { projectId: string }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const queryClient = useQueryClient();

  const createSession = useCreateAgentSession(projectId);
  const sendMessage = useSendAgentMessage(projectId);
  const session = useAgentSession(projectId, sessionId ?? undefined);

  const messages = session.data?.messages ?? [];
  const busy = createSession.isPending || sendMessage.isPending;

  const scrollRef = useRef<HTMLDivElement>(null);
  const messageCount = messages.length;
  useEffect(() => {
    if (messageCount > 0) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [messageCount]);

  const submit = async () => {
    const message = draft.trim();
    if (!message || busy) return;
    setDraft("");

    const targetSessionId =
      sessionId ?? (await createSession.mutateAsync({})).id;
    if (!sessionId) setSessionId(targetSessionId);

    await sendMessage.mutateAsync({ sessionId: targetSessionId, message });
    // The agent may have synced file changes back into the dev working copy.
    await queryClient.invalidateQueries({
      queryKey: ["cat", "project", projectId],
    });
  };

  const error = createSession.error ?? sendMessage.error;

  return (
    <aside className="pg-chat">
      <div className="pg-chat-header">
        <span>AI assistant</span>
        {sessionId && (
          <button
            type="button"
            className="pg-chat-new"
            onClick={() => setSessionId(null)}
            disabled={busy}
          >
            New session
          </button>
        )}
      </div>
      <div className="pg-chat-messages" ref={scrollRef}>
        {messages.length === 0 && !busy && (
          <p className="pg-chat-hint">
            Ask the agent to build or change workflows — e.g. “add a retry step
            after the payment charge”.
          </p>
        )}
        {messages.map((message) => (
          <ChatMessage key={message.id} message={message} />
        ))}
        {busy && <p className="pg-chat-hint">Agent is working…</p>}
        {error && <p className="pg-error">{error.message}</p>}
      </div>
      <div className="pg-chat-composer">
        <textarea
          value={draft}
          placeholder="Describe the change…"
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          disabled={busy}
        />
        <button
          type="button"
          className="pg-btn"
          onClick={() => void submit()}
          disabled={busy || !draft.trim()}
        >
          Send
        </button>
      </div>
    </aside>
  );
}

function ChatMessage({ message }: { message: AgentMessage }) {
  const changedFiles = changedFilesFrom(message);
  return (
    <div className={`pg-chat-message ${message.role}`}>
      <div className="pg-chat-role">
        {message.role === "user" ? "You" : "Agent"}
      </div>
      <div className="pg-chat-content">{message.content}</div>
      {changedFiles.length > 0 && (
        <div className="pg-chat-files">
          {changedFiles.map((file) => (
            <span key={file} className="pg-chat-file">
              {file}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function changedFilesFrom(message: AgentMessage): string[] {
  const changed = message.metadata?.changedFiles;
  if (!Array.isArray(changed)) return [];
  return changed.flatMap((entry) =>
    typeof entry === "object" &&
    entry !== null &&
    "path" in entry &&
    typeof entry.path === "string"
      ? [entry.path]
      : [],
  );
}
