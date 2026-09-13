import { useQuery } from "@tanstack/react-query";
import { CircleDot, FileText, FolderOpen, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { desktopApi } from "../lib/desktop-api.js";
import { localEditorPath } from "../lib/local-project-files.js";
import { ResourceInspector } from "./resource-inspector.js";

/** File lifecycle uses the same status and actions surface as chat. */
export function FileInspector({
  projectId,
  filePath,
  dirty,
  saving,
  onSave,
  onPublish,
  onPropose,
  onSharePersonal,
}: {
  projectId: string;
  filePath: string;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onPublish?: () => Promise<void>;
  onPropose?: () => Promise<void>;
  onSharePersonal?: (intent: "publish" | "propose") => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const location = useQuery({
    queryKey: ["file-location", projectId, filePath],
    queryFn: () => localEditorPath(projectId, filePath),
  });
  const personal =
    filePath.startsWith(".catamorphic/personal/") ||
    filePath.includes("/.catamorphic/personal/");
  const status = saving
    ? "Saving"
    : dirty
      ? "Unsaved changes"
      : "Saved on this device";
  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const buttonClass =
    "w-full cursor-pointer rounded-md px-2 py-1.5 text-left text-[11px] text-fg-muted transition-colors hover:bg-bg-overlay hover:text-fg disabled:cursor-not-allowed disabled:opacity-50";
  return (
    <ResourceInspector
      label="File status and actions"
      pinOnClick
      content={
        <>
          <header className="flex items-start gap-2.5 border-b border-border pb-3">
            <FileText className="mt-0.5 size-4 shrink-0 text-accent" />
            <h2 className="min-w-0 break-words text-[13px] font-semibold text-fg">
              {filePath.split("/").at(-1)}
            </h2>
          </header>
          <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-2 py-3 text-[11px]">
            <dt className="text-fg-faint">Status</dt>
            <dd className="text-fg">{status}</dd>
            <dt className="text-fg-faint">Visibility</dt>
            <dd className="text-fg">
              {personal ? "Local only" : "Project file (local copy)"}
            </dd>
            <dt className="text-fg-faint">Location</dt>
            <dd className="break-all text-fg">{location.data ?? filePath}</dd>
          </dl>
          <p className="pb-3 text-[11px] leading-4 text-fg-muted">
            {personal
              ? "This personal file is excluded from project sync and proposals."
              : "Saving updates your local copy. Publishing and proposing are separate actions."}
          </p>
          <div className="border-t border-border pt-2">
            {personal && onSharePersonal && (
              <>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={saving}
                  onClick={() => void run(() => onSharePersonal("propose"))}
                >
                  Propose to project…
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={saving}
                  onClick={() => void run(() => onSharePersonal("publish"))}
                >
                  Publish…
                </button>
                <p className="px-2 pb-2 text-[10px] text-fg-faint">
                  Your agent will prepare this file for sharing.
                </p>
              </>
            )}
            <button
              type="button"
              className={buttonClass}
              disabled={!location.data}
              onClick={() =>
                void run(() => desktopApi.revealFolder(location.data ?? ""))
              }
            >
              <span className="flex items-center gap-2">
                <FolderOpen className="size-3.5" />
                Show in Finder
              </span>
            </button>
            {dirty && (
              <button
                type="button"
                className={buttonClass}
                disabled={saving}
                onClick={onSave}
              >
                Save on this device
              </button>
            )}
            {!personal && onPropose && (
              <button
                type="button"
                className={buttonClass}
                disabled={saving}
                onClick={() => void run(onPropose)}
              >
                Propose changes
              </button>
            )}
            {!personal && onPublish && (
              <button
                type="button"
                className={buttonClass}
                disabled={saving}
                onClick={() => void run(onPublish)}
              >
                Publish…
              </button>
            )}
          </div>
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
          aria-label={`File status: ${status}`}
          data-testid="file-inspector-trigger"
          className="flex h-7 max-w-64 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-fg-muted transition-colors hover:bg-bg-overlay hover:text-fg"
        >
          {saving ? (
            <LoaderCircle className="size-3 animate-spin text-accent" />
          ) : (
            <CircleDot className="size-3 text-accent" />
          )}
          <span>{dirty ? "Unsaved" : "This device"}</span>
          {personal && (
            <span className="rounded bg-bg-inset px-1.5 py-0.5 text-[9px] text-fg-faint">
              Local only
            </span>
          )}
        </button>
      )}
    </ResourceInspector>
  );
}
