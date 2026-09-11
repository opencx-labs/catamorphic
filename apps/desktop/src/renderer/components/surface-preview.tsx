import { useWorkflows } from "@catamorphic/react";
import { useContext, useEffect, useState } from "react";
import type { ChatSurface } from "../../shared/chat";
import { sanitizeTerminalOutput } from "../../shared/terminal-text";
import { desktopApi } from "../lib/desktop-api";
import { useApps } from "../screens/app-screen";
import { ResourcePreviewContent } from "./catamorphic/resource-preview";
import { FilePreview, FilePreviewProjectContext } from "./file-preview";
import { WebPreview } from "./web-preview";

export const SURFACE_LABELS = {
  browser: "Page",
  terminal: "Terminal",
  editor: "File",
  chat: "Chat",
  subagent: "Subagent",
  watcher: "Watcher",
  app: "App",
  workflow: "Workflow",
  mcpapp: "App view",
} as const;

/** A surface stays a resource on hover; inspection never opens or starts it. */
export function SurfacePreview({ surface }: { surface: ChatSurface }) {
  if (surface.filePath) return <FilePreview filePath={surface.filePath} />;
  if (surface.url) return <WebPreview url={surface.url} />;
  if (surface.terminalSessionId)
    return (
      <TerminalPreview
        surface={surface}
        sessionId={surface.terminalSessionId}
      />
    );
  if (surface.kind === "workflow") return <WorkflowPreview surface={surface} />;
  if (surface.kind === "app") return <AppPreview surface={surface} />;
  return <SurfaceSummary surface={surface} />;
}

function SurfaceSummary({ surface }: { surface: ChatSurface }) {
  return (
    <ResourcePreviewContent
      preview={{
        name: surface.label,
        typeLabel: SURFACE_LABELS[surface.kind],
        content: {
          kind: "summary",
          text:
            [
              surface.attention
                ? "Ready for you"
                : surface.active
                  ? "Working"
                  : undefined,
              surface.description,
              ...(surface.info ?? []),
            ]
              .filter(Boolean)
              .join("\n") ||
            `Open ${SURFACE_LABELS[surface.kind].toLowerCase()} to view it.`,
        },
      }}
    />
  );
}

function TerminalPreview({
  surface,
  sessionId,
}: {
  surface: ChatSurface;
  sessionId: string;
}) {
  const [result, setResult] = useState<{
    key: string;
    text?: string;
    failed?: boolean;
  }>();
  const [retry, setRetry] = useState(0);
  const key = `${sessionId}:${retry}`;
  useEffect(() => {
    let current = true;
    void desktopApi
      .terminalBuffer(sessionId)
      .then((value) => {
        if (current)
          setResult({
            key,
            text: value
              ? sanitizeTerminalOutput(value.buffer).slice(-16000)
              : undefined,
            failed: !value,
          });
      })
      .catch(() => {
        if (current) setResult({ key, failed: true });
      });
    return () => {
      current = false;
    };
  }, [sessionId, key]);
  const value = result?.key === key ? result : undefined;
  return (
    <>
      <ResourcePreviewContent
        preview={{
          name: surface.label,
          typeLabel: "Terminal",
          content: !value
            ? { kind: "summary", text: "Loading recent output…" }
            : value.failed
              ? {
                  kind: "unavailable",
                  message: "This terminal is no longer available.",
                }
              : value.text
                ? { kind: "text", text: value.text }
                : { kind: "summary", text: "No output yet." },
        }}
      />
      {value?.failed && (
        <button
          type="button"
          className="mt-2 text-xs text-accent hover:underline"
          onClick={() => {
            setResult(undefined);
            setRetry((value) => value + 1);
          }}
        >
          Retry preview
        </button>
      )}
    </>
  );
}

function WorkflowPreview({ surface }: { surface: ChatSurface }) {
  const projectId = useContext(FilePreviewProjectContext);
  const query = useWorkflows(projectId);
  const name = surface.key.slice("workflow:".length);
  const workflow = query.data?.find((workflow) => workflow.name === name);
  return (
    <SurfaceSummary
      surface={{
        ...surface,
        label: workflow?.displayName ?? surface.label,
        description: workflow
          ? [
              workflow.description,
              `${workflow.parameterCount} ${workflow.parameterCount === 1 ? "input" : "inputs"}`,
              workflow.triggers.length
                ? `${workflow.triggers.length} ${workflow.triggers.length === 1 ? "trigger" : "triggers"}`
                : undefined,
            ]
              .filter(Boolean)
              .join("\n")
          : query.isError
            ? "Workflow details are unavailable. Open the workflow to try again."
            : surface.description,
      }}
    />
  );
}

function AppPreview({ surface }: { surface: ChatSurface }) {
  const projectId = useContext(FilePreviewProjectContext);
  const query = useApps(projectId);
  const app = query.data?.find(
    (app) => app.name === surface.key.slice("app:".length),
  );
  return (
    <SurfaceSummary
      surface={{
        ...surface,
        description: app
          ? app.publishedAt
            ? "Published"
            : app.activeVersionId
              ? "Ready to preview"
              : "No successful build yet"
          : query.isError
            ? "App details are unavailable. Open the app to try again."
            : surface.description,
      }}
    />
  );
}
