import {
  ArrowDown,
  ArrowUp,
  Bot,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Plus,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useState,
} from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

export interface AgentChatDockMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: unknown;
}

export interface AgentChatDockProps {
  messages: readonly AgentChatDockMessage[];
  isWorking?: boolean;
  queuedMessageCount?: number;
  error?: string | null;
  onSend: (message: string) => Promise<void> | void;
  onNewSession?: () => void;
  renderMessageFooter?: (message: AgentChatDockMessage) => ReactNode;
  emptyState?: ReactNode;
  workingLabel?: string;
  placeholder?: string;
  title?: string;
  collapsedSummary?: string;
  className?: string;
  defaultExpanded?: boolean;
}

export function AgentChatDock({
  messages,
  isWorking = false,
  queuedMessageCount = 0,
  error,
  onSend,
  onNewSession,
  renderMessageFooter,
  emptyState = "Ask the agent to build or change your project.",
  workingLabel = "Agent is working",
  placeholder = "Describe a change...",
  title = "AI assistant",
  collapsedSummary,
  className,
  defaultExpanded = false,
}: AgentChatDockProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [draft, setDraft] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const latestMessage = messages.at(-1);
  const busy = isWorking || isSubmitting;
  const statusText = busy
    ? workingLabel
    : (error ??
      submissionError ??
      collapsedSummary ??
      latestMessage?.content ??
      "Ready for a request");

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const message = draft.trim();
    if (!message || isSubmitting) return;
    setExpanded(true);
    setSubmissionError(null);
    setIsSubmitting(true);
    try {
      await onSend(message);
      setDraft("");
    } catch (cause) {
      setSubmissionError(
        cause instanceof Error ? cause.message : "Failed to send message",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <section
      className={`catamorphic-agent-dock${expanded ? " is-expanded" : ""}${className ? ` ${className}` : ""}`}
      aria-label={title}
    >
      <span className="catamorphic-agent-dock-live" aria-live="polite">
        {statusText}
      </span>
      <div
        className="catamorphic-agent-dock-panel"
        aria-hidden={!expanded}
        inert={!expanded ? true : undefined}
      >
        <header className="catamorphic-agent-dock-header">
          <div className="catamorphic-agent-dock-heading">
            <span className="catamorphic-agent-dock-mark" aria-hidden="true">
              <Bot size={15} />
            </span>
            <span>{title}</span>
          </div>
          <div className="catamorphic-agent-dock-actions">
            {onNewSession && (
              <button
                type="button"
                onClick={onNewSession}
                disabled={busy}
                aria-label="Start new agent session"
                title="New session"
              >
                <Plus size={15} />
              </button>
            )}
            <button
              type="button"
              onClick={() => setExpanded(false)}
              aria-label="Collapse agent chat"
              aria-expanded="true"
            >
              <Minimize2 size={15} />
            </button>
          </div>
        </header>
        <StickToBottom
          className="catamorphic-agent-dock-conversation"
          initial="smooth"
          resize="smooth"
          role="log"
        >
          <StickToBottom.Content className="catamorphic-agent-dock-messages">
            {messages.length === 0 && !busy && (
              <div className="catamorphic-agent-dock-empty">{emptyState}</div>
            )}
            {messages.map((message) => (
              <article
                key={message.id}
                className={`catamorphic-agent-dock-message is-${message.role}`}
              >
                <div className="catamorphic-agent-dock-role">
                  {message.role === "user"
                    ? "You"
                    : message.role === "system"
                      ? "System"
                      : "Agent"}
                </div>
                <div className="catamorphic-agent-dock-content">
                  {message.content}
                </div>
                {renderMessageFooter?.(message)}
              </article>
            ))}
            {busy && (
              <div className="catamorphic-agent-dock-working">
                <LoaderCircle size={14} aria-hidden="true" />
                <span className="catamorphic-agent-dock-shimmer">
                  {workingLabel}
                </span>
                {queuedMessageCount > 1 && (
                  <span className="catamorphic-agent-dock-queued">
                    {queuedMessageCount - 1} queued
                  </span>
                )}
              </div>
            )}
            {(error ?? submissionError) && (
              <div className="catamorphic-agent-dock-error" role="alert">
                {error ?? submissionError}
              </div>
            )}
          </StickToBottom.Content>
          <ConversationScrollButton />
        </StickToBottom>
      </div>

      <div className="catamorphic-agent-dock-bar">
        <form className="catamorphic-agent-dock-composer" onSubmit={submit}>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder={placeholder}
            rows={1}
            aria-label="Message the coding agent"
          />
          <button
            type="button"
            className="catamorphic-agent-dock-expand"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-label={
              expanded ? "Collapse conversation" : "Expand conversation"
            }
            title={expanded ? "Collapse conversation" : "Expand conversation"}
          >
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button
            type="submit"
            className="catamorphic-agent-dock-send"
            disabled={isSubmitting || !draft.trim()}
            aria-label="Send message"
          >
            <ArrowUp size={16} />
          </button>
        </form>
      </div>
    </section>
  );
}

function ConversationScrollButton() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <button
      type="button"
      className="catamorphic-agent-dock-scroll"
      onClick={() => scrollToBottom()}
      aria-label="Scroll to latest message"
    >
      <ArrowDown size={15} />
    </button>
  );
}
