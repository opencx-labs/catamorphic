import { useWorkflows } from "@catamorphic/react";
import { useContext, useEffect, useState } from "react";
import { sanitizeTerminalOutput } from "../../shared/terminal-text";
import { type Chip, chipKind } from "../lib/chips";
import { desktopApi } from "../lib/desktop-api";
import { useApps } from "../screens/app-screen";
import { ResourcePreviewContent } from "./catamorphic/resource-preview";
import { FilePreview, FilePreviewProjectContext } from "./file-preview";
import { PreviewCard } from "./sidebar-preview";
import { WebPreview } from "./web-preview";

/** What each of Work's chips is called in its preview. */
export const CHIP_KIND_LABELS: Partial<Record<string, string>> = {
  browser: "Page",
  terminal: "Terminal",
  editor: "File",
  chat: "Chat",
  subagent: "Subagent",
  app: "App",
  workflow: "Workflow",
  mcpapp: "App view",
  "pull-request": "Pull request",
  group: "Chips",
};

const text = (value: unknown) =>
  typeof value === "string" && value ? value : undefined;

/**
 * A chip's hover preview (ADR 0239): the card it declares, else a live look
 * at what it stands for (a page, a terminal's output, a file, a workflow or
 * an app, from its `data`), else what it says about itself. Inspection
 * never opens or starts anything.
 */
export function ChipPreview({ chip }: { chip: Chip }) {
  if (chip.preview)
    return <PreviewCard preview={chip.preview} fallbackTitle={chip.label} />;
  const data = chip.data ?? {};
  const kind = chipKind(chip);
  const filePath = text(data.filePath);
  if (filePath) return <FilePreview filePath={filePath} />;
  const url = text(data.url);
  if (kind === "browser" && url) return <WebPreview url={url} />;
  const terminal = text(data.terminalSessionId);
  if (terminal) return <TerminalPreview chip={chip} sessionId={terminal} />;
  const name = text(data.name);
  if (kind === "workflow" && name)
    return <WorkflowPreview chip={chip} name={name} />;
  if (kind === "app" && name) return <AppPreview chip={chip} name={name} />;
  return <ChipSummary chip={chip} />;
}

function ChipSummary({
  chip,
  description = chip.description,
}: {
  chip: Chip;
  description?: string;
}) {
  const kind = chipKind(chip);
  const typeLabel = (kind && CHIP_KIND_LABELS[kind]) ?? "Chip";
  return (
    <ResourcePreviewContent
      preview={{
        name: chip.label,
        typeLabel,
        content: {
          kind: "summary",
          text:
            [
              chip.signal === "attention"
                ? "Ready for you"
                : chip.signal === "working"
                  ? "Working"
                  : undefined,
              description,
            ]
              .filter(Boolean)
              .join("\n") || `Open ${typeLabel.toLowerCase()} to view it.`,
        },
      }}
    />
  );
}

function TerminalPreview({
  chip,
  sessionId,
}: {
  chip: Chip;
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
          name: chip.label,
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

function WorkflowPreview({ chip, name }: { chip: Chip; name: string }) {
  const projectId = useContext(FilePreviewProjectContext);
  const query = useWorkflows(projectId);
  const workflow = query.data?.find((workflow) => workflow.name === name);
  return (
    <ChipSummary
      chip={{ ...chip, label: workflow?.displayName ?? chip.label }}
      description={
        workflow
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
            : chip.description
      }
    />
  );
}

function AppPreview({ chip, name }: { chip: Chip; name: string }) {
  const projectId = useContext(FilePreviewProjectContext);
  const query = useApps(projectId);
  const app = query.data?.find((app) => app.name === name);
  return (
    <ChipSummary
      chip={chip}
      description={
        app
          ? app.publishedAt
            ? "Published"
            : app.activeVersionId
              ? "Ready to preview"
              : "No successful build yet"
          : query.isError
            ? "App details are unavailable. Open the app to try again."
            : chip.description
      }
    />
  );
}
