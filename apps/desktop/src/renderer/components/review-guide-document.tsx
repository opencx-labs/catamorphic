import { useAgentCatalog, useAgentChat } from "@catamorphic/react";
import { useEffect, useState } from "react";
import type { PullRequestFile } from "../lib/desktop-api.js";
import { extractGuide, guidePrompt } from "../lib/review-guide-document.js";

import { ReviewGuideContent } from "./review-guide-content.js";

function stored(key: string) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** Agent orchestration stays headless; Markdown is the editable review artifact. */
export function ReviewGuideDocument({
  projectId,
  number,
  title,
  body,
  files,
  revision,
  onOpenFile,
}: {
  projectId: string;
  number: number;
  title: string;
  body: string;
  files: PullRequestFile[];
  revision: string;
  onOpenFile: (file: PullRequestFile) => void;
}) {
  const key = `review-guide:${projectId}:${number}`;
  const [document, setDocument] = useState(() => stored(key));
  const [sessionId, setSessionId] = useState(() => stored(`${key}:session`));
  const [agentId, setAgentId] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saveError, setSaveError] = useState("");
  const catalog = useAgentCatalog(projectId);
  const chosenId =
    agentId ||
    catalog.data?.defaultAgentId ||
    catalog.data?.items.find((agent) => agent.available)?.id;
  const agent = catalog.data?.items.find((item) => item.id === chosenId);
  const environment =
    agent?.environments.items.find(
      (item) =>
        item.preferred && item.available && item.allowed && item.compatible,
    )?.name ?? agent?.environments.defaultEnvironment;
  const chat = useAgentChat(projectId, {
    agentId: chosenId,
    environment,
    source: "desktop",
    sessionId: sessionId || undefined,
    onSessionCreated: (id) => {
      setSessionId(id);
      try {
        localStorage.setItem(`${key}:session`, id);
      } catch {
        setSaveError("Could not save this guide session.");
      }
    },
  });
  const busy = chat.isSending || chat.isWorking;
  const latest = chat.messages
    .filter((message) => message.role === "assistant")
    .at(-1);
  useEffect(() => {
    if (busy || !latest || stored(`${key}:message`) === latest.id) return;
    const result = extractGuide(latest.content);
    if (!result) return;
    setDocument(result);
    try {
      localStorage.setItem(key, result);
      localStorage.setItem(`${key}:message`, latest.id);
      localStorage.setItem(
        `${key}:revision`,
        stored(`${key}:pending-revision`),
      );
    } catch {
      setSaveError(
        "Could not save the guide. Copy your Markdown before closing.",
      );
    }
  }, [latest, busy, key]);
  const generate = () => {
    try {
      localStorage.setItem(`${key}:pending-revision`, revision);
    } catch {
      setSaveError("Could not save guide revision.");
    }
    void chat.send(guidePrompt({ title, body, files }));
  };
  return (
    <section className="min-w-0" aria-label="Code review guide">
      <header className="mb-5 flex flex-wrap items-center gap-3">
        <h2 className="mr-auto text-base font-semibold">Review guide</h2>
        {!sessionId && (
          <select
            aria-label="Guide agent"
            className="field max-w-48 rounded px-2 py-1 text-xs"
            value={chosenId ?? ""}
            onChange={(event) => setAgentId(event.target.value)}
          >
            {!chosenId && <option value="">Choose an agent</option>}
            {catalog.data?.items.map((item) => (
              <option key={item.id} value={item.id} disabled={!item.available}>
                {item.name}
              </option>
            ))}
          </select>
        )}
        {document && !busy && (
          <button
            type="button"
            onClick={() => {
              setDraft(document);
              setEditing(true);
            }}
            className="rounded px-2 py-1 text-xs hover:bg-bg-overlay"
          >
            Edit Markdown
          </button>
        )}
        {busy ? (
          <button
            type="button"
            onClick={() => void chat.interrupt()}
            className="rounded px-3 py-1.5 text-xs hover:bg-bg-overlay"
          >
            Stop generation
          </button>
        ) : (
          <button
            type="button"
            disabled={!agent?.available || !files.length}
            data-disabled-reason={
              !agent?.available
                ? "Configure an available agent in Settings"
                : !files.length
                  ? "Wait for changed files to load"
                  : undefined
            }
            onClick={generate}
            className="rounded bg-bg-overlay px-3 py-1.5 text-xs font-medium hover:bg-bg-raised disabled:opacity-50"
          >
            {document ? "Regenerate" : "Generate guide"}
          </button>
        )}
      </header>
      {(chat.error || saveError || catalog.error) && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {saveError || chat.error?.message || catalog.error?.message}
        </p>
      )}
      {busy && (
        <p role="status" className="mb-4 text-sm text-fg-muted">
          {chat.activity ?? "Analyzing the changed code…"}
        </p>
      )}
      {document && stored(`${key}:revision`) !== revision && (
        <p className="mb-4 text-xs text-warning">
          Changes have updated since this guide was generated. Regenerate to
          review the latest patch.
        </p>
      )}
      {!document && !busy && (
        <div className="mb-5 text-sm leading-relaxed text-fg-muted">
          <p>
            Follow how this change works, with explanations and links to the
            relevant code.
          </p>
          <p className="mt-2 text-xs">
            Uses your configured agent. You can edit the resulting Markdown. The
            change map below is available without generation.
          </p>
          {latest && !extractGuide(latest.content) && (
            <p className="mt-3 text-warning">
              The agent did not return a complete guide. Generate again or use
              the change map.
            </p>
          )}
        </div>
      )}
      {editing ? (
        <div className="flex flex-col gap-3">
          <textarea
            aria-label="Guide Markdown"
            className="field min-h-96 w-full rounded p-3 font-mono text-xs"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => {
                setDocument(draft);
                try {
                  localStorage.setItem(key, draft);
                  setSaveError("");
                  setEditing(false);
                } catch {
                  setSaveError("Could not save your edits.");
                }
              }}
              className="rounded bg-bg-overlay px-3 py-1.5 text-xs"
            >
              Save guide
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="px-3 py-1.5 text-xs"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        document && (
          <ReviewGuideContent
            markdown={document}
            files={files}
            onOpenFile={onOpenFile}
          />
        )
      )}
    </section>
  );
}
