import type { AgentSession } from "@catamorphic/react/types";
import { useEffect, useState } from "react";
import { Modal } from "./modal.js";
import { PendingButton } from "./pending-button.js";

export interface SessionAgentOption {
  id: string;
  name: string;
}

export function CreateSubsessionDialog({
  parent,
  agents,
  defaultAgentId,
  pending,
  error,
  onClose,
  onCreate,
}: {
  parent: AgentSession | null;
  agents: SessionAgentOption[];
  defaultAgentId: string | null;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (input: { title?: string; agentId?: string }) => void;
}) {
  const inheritedAgentId =
    [parent?.agentId, defaultAgentId].find(
      (candidate) =>
        candidate !== null &&
        candidate !== undefined &&
        agents.some((agent) => agent.id === candidate),
    ) ?? "";
  const [agentId, setAgentId] = useState(inheritedAgentId);
  const [title, setTitle] = useState("");

  useEffect(() => {
    setAgentId(inheritedAgentId);
    setTitle("");
  }, [inheritedAgentId]);

  return (
    <Modal open={parent !== null} onClose={onClose} width={420}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onCreate({
            ...(title.trim() ? { title: title.trim() } : {}),
            ...(agentId ? { agentId } : {}),
          });
        }}
      >
        <div className="px-5 pt-5">
          <h2 className="text-sm font-semibold text-fg">New subsession</h2>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            Create a child beneath {parent?.title ?? "this chat"}. It starts
            with the parent&apos;s agent when it is available here.
          </p>
          <label className="mt-4 block text-xs font-medium text-fg-muted">
            Agent
            <select
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
              className="mt-1.5 h-9 w-full rounded-md border border-border bg-bg-inset px-2.5 text-[13px] text-fg outline-none focus:border-accent"
            >
              {!agentId ? <option value="">Default agent</option> : null}
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-3 block text-xs font-medium text-fg-muted">
            Title <span className="font-normal text-fg-faint">optional</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="What will this child work on?"
              className="mt-1.5 h-9 w-full rounded-md border border-border bg-bg-inset px-2.5 text-[13px] text-fg outline-none placeholder:text-fg-faint focus:border-accent"
            />
          </label>
          {error ? <p className="mt-3 text-xs text-danger">{error}</p> : null}
        </div>
        <footer className="mt-5 flex justify-end gap-2 border-t border-border px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-md px-3 text-[13px] text-fg-muted hover:bg-bg-overlay hover:text-fg"
          >
            Cancel
          </button>
          <PendingButton
            type="submit"
            pending={pending}
            pendingLabel="Starting…"
            className="h-8 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg disabled:opacity-50"
          >
            Start subsession
          </PendingButton>
        </footer>
      </form>
    </Modal>
  );
}

export function ArchiveSessionDialog({
  session,
  sessionCount,
  runningCount,
  watcherCount,
  watchers,
  processCount,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  session: AgentSession | null;
  sessionCount: number;
  runningCount: number;
  watcherCount: number;
  watchers: Array<{
    id: string;
    name: string;
    environment: string | null;
    nextRunAt: string | null;
  }>;
  processCount: number;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={session !== null}
      onClose={onClose}
      width={440}
      labelledBy="archive-session-title"
    >
      <div className="px-5 pt-5">
        <h2
          id="archive-session-title"
          className="text-sm font-semibold text-fg"
        >
          Archive {session?.title ?? "this chat"}?
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-fg-muted">
          Archiving hides this session and its subsessions. Agents can still
          find and read them, and you can find them in the command palette.
        </p>
        <div className="mt-4 rounded-lg border border-border bg-bg-inset px-3 py-2.5 text-xs text-fg-muted">
          {sessionCount} {sessionCount === 1 ? "session" : "sessions"}
          {runningCount > 0 ? `, ${runningCount} active` : ""}
          {watcherCount > 0
            ? `, ${watcherCount} ${watcherCount === 1 ? "reminder or monitor" : "reminders and monitors"}`
            : ""}
          {processCount > 0 ? `, ${processCount} running processes` : ""}
          {" will be stopped."}
        </div>
        {watchers.length > 0 && (
          <div className="mt-3 text-xs text-fg-muted">
            <p>
              These reminders and monitors will be cancelled. Restoring the chat
              will not restart them.
            </p>
            <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto rounded-lg border border-border p-3">
              {watchers.map((watcher) => (
                <li key={watcher.id}>
                  <div className="font-medium text-fg">{watcher.name}</div>
                  <div>
                    {watcher.nextRunAt
                      ? `Next: ${new Date(watcher.nextRunAt).toLocaleString()}`
                      : "Event monitor or paused schedule"}
                  </div>
                  <div>{watcher.environment}</div>
                </li>
              ))}
            </ul>
          </div>
        )}
        {error ? <p className="mt-3 text-xs text-danger">{error}</p> : null}
      </div>
      <footer className="mt-4 flex justify-end gap-2 border-t border-border px-5 py-3.5">
        <button
          type="button"
          onClick={onClose}
          className="h-8 rounded-md px-3 text-[13px] text-fg-muted hover:bg-bg-overlay hover:text-fg"
        >
          Cancel
        </button>
        <PendingButton
          data-testid="archive-session-confirm"
          type="button"
          onClick={onConfirm}
          pending={pending}
          pendingLabel="Archiving…"
          className="h-8 rounded-md border border-danger/40 bg-danger/10 px-3 text-[13px] font-medium text-danger hover:bg-danger/20 disabled:opacity-50"
        >
          {watcherCount > 0
            ? "Archive and cancel reminders"
            : "Stop and archive"}
        </PendingButton>
      </footer>
    </Modal>
  );
}
