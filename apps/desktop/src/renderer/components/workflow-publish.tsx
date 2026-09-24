import {
  useDeployProject,
  useProjectGit,
  useWorkflow,
} from "@catamorphic/react";
import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { desktopApi } from "../lib/desktop-api.js";
import { Collapsible } from "./collapsible.js";
import { PendingButton } from "./pending-button.js";

/**
 * Runs, manual or automatic, use the published project version. This is the
 * one place that knows whether this workflow is in it and how to publish.
 */
export function useWorkflowPublication({
  projectId,
  workflowName,
  dirty,
  canPublish,
}: {
  projectId: string;
  workflowName: string;
  dirty: boolean;
  canPublish: boolean;
}) {
  const status = useProjectGit(projectId);
  const published = useWorkflow(
    status.data?.remoteHead ? projectId : undefined,
    workflowName,
    { ref: status.data?.remoteHead ?? undefined },
  );
  const deploy = useDeployProject(projectId);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string>();
  const changedFiles = status.data?.modifiedFiles ?? [];
  const missing =
    !status.isPending &&
    (!status.data?.remoteHead || published.error?.status === 404);
  const unpublished = Boolean(
    status.data && (status.data.dirty || status.data.ahead > 0),
  );
  const publishing = recording || deploy.isPending;
  const publishBlocked = !canPublish
    ? "Only project builders can publish"
    : dirty
      ? "Save your workflow changes before publishing"
      : undefined;
  // Publishing records the saved changes in project history, then makes that
  // version the one new runs use.
  const publish = async () => {
    if (publishBlocked || publishing) return;
    setError(undefined);
    try {
      if (status.data?.dirty && changedFiles.length) {
        setRecording(true);
        try {
          await desktopApi.gitRecord({
            projectId,
            paths: changedFiles,
            message: `Record changes for ${workflowName}`,
          });
        } finally {
          setRecording(false);
        }
      }
      const result = await deploy.mutateAsync({
        message: `Publish project for ${workflowName}`,
      });
      if (result.status === "conflict")
        setError(
          "The project has conflicting changes. Resolve them in Changes before publishing again.",
        );
      await status.refetch();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not publish the project.",
      );
    }
  };
  return {
    status,
    published,
    missing,
    unpublished,
    changedFiles,
    publishing,
    publishBlocked,
    publish,
    error: error ?? status.error?.message,
  };
}

export type WorkflowPublication = ReturnType<typeof useWorkflowPublication>;

export function WorkflowPublishCallout({
  publication,
  purpose,
}: {
  publication: WorkflowPublication;
  purpose: "runs" | "automatic";
}) {
  const id = useId();
  const [filesOpen, setFilesOpen] = useState(false);
  const {
    status,
    missing,
    unpublished,
    changedFiles,
    publishing,
    publishBlocked,
    publish,
    error,
  } = publication;
  const what = purpose === "runs" ? "Runs" : "Automatic runs";
  if (!(missing || unpublished))
    return (
      <>
        {status.data?.remoteHead && (
          <p className="text-xs text-fg-muted">
            {what} use the published version{" "}
            <span className="font-mono">
              {status.data.remoteHead.slice(0, 7)}
            </span>
            .
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-xs text-danger">
            {error}
          </p>
        )}
      </>
    );
  return (
    <section className="workflow-callout" data-testid="workflow-publish">
      <h3>{missing ? "Not published yet" : "Unpublished changes"}</h3>
      <p>
        {missing
          ? `${what} use the published version of this project. Publish to make this workflow available.`
          : `${what} use the published version, without your latest saved changes.`}
      </p>
      {changedFiles.length > 0 && (
        <>
          <button
            type="button"
            className="workflow-text-action mt-1"
            aria-expanded={filesOpen}
            aria-controls={`${id}-files`}
            onClick={() => setFilesOpen(!filesOpen)}
          >
            <ChevronDown
              className={`size-3 transition-transform duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${filesOpen ? "" : "-rotate-90"}`}
            />
            {changedFiles.length === 1
              ? "1 changed file"
              : `${changedFiles.length} changed files`}
          </button>
          <Collapsible open={filesOpen}>
            <ul
              id={`${id}-files`}
              className="max-h-36 overflow-y-auto pt-1 pl-4.5 font-mono text-[11px] text-fg-muted"
            >
              {changedFiles.map((file) => (
                <li key={file} className="truncate">
                  {file}
                </li>
              ))}
            </ul>
          </Collapsible>
        </>
      )}
      <PendingButton
        type="button"
        className="workflow-secondary mt-3"
        pending={publishing}
        aria-disabled={Boolean(publishBlocked)}
        data-disabled-reason={publishBlocked}
        onClick={() => void publish()}
      >
        Publish
      </PendingButton>
      {error && (
        <p role="alert" className="mt-3 text-xs text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
