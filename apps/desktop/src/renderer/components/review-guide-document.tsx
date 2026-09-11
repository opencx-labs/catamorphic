import {
  useAgentCatalog,
  useAgentChat,
  useCatamorphic,
  useSessionArtifacts,
} from "@catamorphic/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { PullRequestFile } from "../lib/desktop-api.js";
import { guidePrompt } from "../lib/review-guide-document.js";
import { AppScreen } from "../screens/app-screen.js";

function stored(key: string) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** Generation produces an ordinary session app; no review-only document format. */
export function ReviewGuideDocument({
  projectId,
  number,
  title,
  body,
  files,
  revision,
  onOpenArtifact,
}: {
  projectId: string;
  number: number;
  title: string;
  body: string;
  files: PullRequestFile[];
  revision: string;
  onOpenArtifact?: (target: string, title: string) => void;
}) {
  const key = `review-app:${projectId}:${number}`;
  const [sessionId, setSessionId] = useState(() => stored(`${key}:session`));
  const [agentId, setAgentId] = useState("");
  const [saveError, setSaveError] = useState("");
  const [inline, setInline] = useState(false);
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
        setSaveError("Could not save this review session.");
      }
    },
  });
  const busy = chat.isSending || chat.isWorking;
  const artifacts = useSessionArtifacts(projectId, sessionId || undefined, {
    refetchInterval: busy ? 2000 : 5000,
  });
  useEffect(() => {
    if (sessionId && !busy) void artifacts.refetch();
  }, [sessionId, busy, artifacts.refetch]);
  const review = artifacts.data?.find(
    (item) => item.kind === "app" && item.status === "active",
  );
  const { apiClient } = useCatamorphic();
  const build = useQuery({
    queryKey: ["cat", projectId, "review-app-build", review?.appName],
    enabled: Boolean(review?.appName),
    // Build completion can follow the chat execution-state update. Keep the
    // visible result fresh independently, like AppMount.
    refetchInterval: 3000,
    queryFn: async () => {
      if (!review?.appName) return null;
      const result = await apiClient.GET(
        "/api/projects/{projectId}/apps/{appName}/view-state",
        {
          params: {
            path: { projectId, appName: review.appName },
            query: { channel: "dev" },
          },
        },
      );
      if (!result.data) throw new Error("Could not load the review build.");
      return result.data;
    },
  });
  useEffect(() => {
    if (review?.appName && !busy) void build.refetch();
  }, [review?.appName, busy, build.refetch]);
  const generate = () => {
    try {
      localStorage.setItem(`${key}:revision`, revision);
    } catch {
      setSaveError("Could not save the compared revision.");
    }
    void chat.send(
      guidePrompt({
        title,
        body,
        files,
        projectId,
        number,
        revision,
        artifactId: review?.id,
      }),
    );
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
            {review ? "Update review" : "Generate guide"}
          </button>
        )}
      </header>
      {(chat.error ||
        saveError ||
        catalog.error ||
        artifacts.error ||
        build.error) && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {saveError ||
            chat.error?.message ||
            catalog.error?.message ||
            artifacts.error?.message ||
            build.error?.message}
        </p>
      )}
      {review && !busy && build.data?.state !== "ready" && (
        <p className="mb-3 text-sm text-fg-muted">
          The review has no successful build yet. Update it to retry.
        </p>
      )}
      {busy && (
        <p role="status" className="mb-4 text-sm text-fg-muted">
          {chat.activity ?? "Building the review…"}
        </p>
      )}
      {review && stored(`${key}:revision`) !== revision && (
        <p className="mb-4 text-xs text-warning">
          Changes have updated since this review was requested. Update it to
          review the latest patch.
        </p>
      )}
      {review?.appName && build.data?.state === "ready" ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-fg-muted">
            {review.title}. Saved with this review session.
          </p>
          <button
            type="button"
            className="self-start rounded bg-bg-overlay px-3 py-2 text-xs"
            onClick={() =>
              onOpenArtifact
                ? onOpenArtifact(`app:${review.appName}`, review.title)
                : setInline(true)
            }
          >
            Open review
          </button>
          {inline && (
            <div className="flex h-[640px] min-h-0">
              <AppScreen projectId={projectId} appName={review.appName} />
            </div>
          )}
        </div>
      ) : (
        !busy && (
          <p className="text-sm leading-relaxed text-fg-muted">
            Generate an interactive review with explanations, findings and code
            changes. It uses your configured agent and stays with this session.
            The change map below is available immediately.
          </p>
        )
      )}
    </section>
  );
}
