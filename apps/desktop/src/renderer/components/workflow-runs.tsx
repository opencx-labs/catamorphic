import {
  useDeployProject,
  useEnvironments,
  useProjectGit,
  useRuns,
  useTriggerRun,
  useWorkflow,
} from "@catamorphic/react";
import type { ParameterInfo } from "@catamorphic/react/types";
import { friendlyParamName } from "@catamorphic/ui";
import { ChevronDown, Play } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { desktopApi } from "../lib/desktop-api.js";
import { RunDetail } from "./catamorphic/runs-panel.js";
import { Collapsible } from "./collapsible.js";
import { PendingButton } from "./pending-button.js";
import { WorkflowSection } from "./workflow-details.js";

function enumValues(
  param: ParameterInfo,
): (string | number | boolean)[] | null {
  const schema = param.schema;
  if (
    !schema ||
    typeof schema !== "object" ||
    !("enum" in schema) ||
    !Array.isArray(schema.enum)
  )
    return null;
  return schema.enum.filter((value): value is string | number | boolean =>
    ["string", "number", "boolean"].includes(typeof value),
  );
}

export function parseWorkflowInput({
  parameters,
  values,
}: {
  parameters: ParameterInfo[];
  values: Record<string, string>;
}): Record<string, unknown> {
  return Object.fromEntries(
    parameters.flatMap((param) => {
      const raw = values[param.name] ?? "";
      if (raw === "" && (param.optional || param.defaultValue != null))
        return [];
      if (raw === "")
        throw new Error(
          `Enter ${param.displayName ?? friendlyParamName(param.name)}.`,
        );
      const choices = enumValues(param);
      if (choices) {
        const choice = choices.find((value) => String(value) === raw);
        if (choice === undefined)
          throw new Error(
            `Choose ${param.displayName ?? friendlyParamName(param.name)}.`,
          );
        return [[param.name, choice]];
      }
      if (param.type === "string") return [[param.name, raw]];
      if (param.type === "number") {
        const value = Number(raw);
        if (!Number.isFinite(value))
          throw new Error(
            `Enter a number for ${friendlyParamName(param.name)}.`,
          );
        return [[param.name, value]];
      }
      if (param.type === "boolean") return [[param.name, raw === "true"]];
      try {
        return [[param.name, JSON.parse(raw)]];
      } catch {
        throw new Error(
          `Enter valid JSON for ${friendlyParamName(param.name)}.`,
        );
      }
    }),
  );
}

export function WorkflowRuns({
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
  const formId = useId();
  const [versionOpen, setVersionOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const status = useProjectGit(projectId);
  const published = useWorkflow(
    status.data?.remoteHead ? projectId : undefined,
    workflowName,
    { ref: status.data?.remoteHead ?? undefined },
  );
  const needsPublish =
    !status.isPending &&
    (!status.data?.remoteHead || published.error?.status === 404);
  useEffect(() => {
    if (needsPublish) setVersionOpen(true);
  }, [needsPublish]);
  const deploy = useDeployProject(projectId);
  const environments = useEnvironments(projectId, { workload: "workflow" });
  const runs = useRuns({ projectId, workflowName, limit: 15 });
  const trigger = useTriggerRun({ projectId, workflowName });
  const [selected, setSelected] = useState<string>();
  const [environmentChoice, setEnvironment] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [jsonMode, setJsonMode] = useState(false);
  const [json, setJson] = useState("{}");
  const available =
    environments.data?.items.filter(
      (item) => item.allowed && item.available && item.compatible,
    ) ?? [];
  const environment =
    available.find((item) => item.name === environmentChoice)?.name ??
    available.find((item) => item.preferred)?.name ??
    available[0]?.name;
  const parameters = published.data?.input.parameters ?? [];
  const blocked = dirty
    ? "Save your changes before starting a run"
    : !environment
      ? "Choose an available environment first"
      : !published.data
        ? "Publish a project version containing this workflow first"
        : undefined;
  const recordableFiles = (status.data?.modifiedFiles ?? []).filter(
    (file) => !file.startsWith("store/"),
  );
  const record = async () => {
    if (dirty || !canPublish || recording || !recordableFiles.length) return;
    setRecording(true);
    setError(undefined);
    try {
      await desktopApi.gitRecord({
        projectId,
        paths: recordableFiles,
        message: `Record changes for ${workflowName}`,
      });
      await status.refetch();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not record the changes.",
      );
    } finally {
      setRecording(false);
    }
  };
  const publish = async () => {
    if (
      dirty ||
      status.data?.dirty ||
      !canPublish ||
      deploy.isPending ||
      recording
    )
      return;
    setError(undefined);
    try {
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
  const start = async () => {
    if (blocked || trigger.isPending || deploy.isPending) return;
    setError(undefined);
    try {
      const input: unknown = jsonMode
        ? JSON.parse(json)
        : parseWorkflowInput({ parameters, values });
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("Input must be a JSON object.");
      // The API validates the complete schema against the deployed workflow.
      const run = await trigger.mutateAsync({ input, environment });
      setSelected(run.id);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not start the run.",
      );
    }
  };
  return (
    <div className="workflow-detail-body" data-testid="workflow-runs">
      <h2 className="text-base font-semibold">Run workflow</h2>
      <p className="mt-2 text-[13px] leading-relaxed text-fg-muted">
        Runs use the published project version. Saving code updates your draft;
        publishing makes it available for new runs.
      </p>
      <div className="workflow-technical">
        <button
          type="button"
          className="workflow-text-action"
          aria-expanded={versionOpen}
          aria-controls={`${formId}-version`}
          onClick={() => setVersionOpen(!versionOpen)}
        >
          <ChevronDown
            className={`size-3 transition-transform duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${versionOpen ? "" : "-rotate-90"}`}
          />
          {status.data?.remoteHead
            ? `Published version ${status.data.remoteHead.slice(0, 7)}`
            : "Publish a version to begin"}
        </button>
        <Collapsible open={versionOpen}>
          <div id={`${formId}-version`}>
            <p className="mt-3 text-xs text-fg-muted">
              Publishing uses the latest Git commit, including its workflows and
              apps. Recording changes saves local history. Publishing makes that
              version available for runs; it does not upload private documents.
              Existing runs keep their version. Automatic runs require a
              separate review.
            </p>
            {recordableFiles.length > 0 && (
              <div className="mt-3">
                <p className="text-xs text-fg-muted">
                  Review the saved files to record:
                </p>
                <ul className="mt-2 max-h-36 overflow-y-auto text-xs font-mono">
                  {recordableFiles.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
                <PendingButton
                  type="button"
                  className="workflow-secondary mt-3"
                  pending={recording}
                  disabled={dirty || !canPublish || deploy.isPending}
                  data-disabled-reason={
                    dirty
                      ? "Save your workflow edits first"
                      : !canPublish
                        ? "Only project builders can record changes"
                        : "Publishing is in progress"
                  }
                  onClick={() => void record()}
                >
                  Record changes in Git
                </PendingButton>
              </div>
            )}
            <PendingButton
              type="button"
              className="workflow-secondary mt-3"
              pending={deploy.isPending}
              disabled={dirty || !canPublish || status.data?.dirty || recording}
              data-disabled-reason={
                !canPublish
                  ? "Only project builders can publish a version"
                  : dirty
                    ? "Save your workflow changes before publishing"
                    : "Record your saved changes in Git before publishing"
              }
              onClick={() => void publish()}
            >
              Publish project version
            </PendingButton>
          </div>
        </Collapsible>
      </div>
      {(status.error || (status.data?.remoteHead && published.error)) && (
        <p className="mt-3 text-xs text-warning">
          {status.error?.message ??
            (published.error?.status === 404
              ? "This workflow is not available in the published version. Publish your saved changes to include it."
              : published.error?.message)}
        </p>
      )}
      <form
        className="mt-5 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <label className="workflow-field">
          <span>Run on</span>
          <select
            value={environment ?? ""}
            onChange={(event) => setEnvironment(event.target.value)}
          >
            <option value="" disabled>
              Choose an environment
            </option>
            {available.map((item) => (
              <option key={item.name} value={item.name}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {environments.error && (
          <p className="text-xs text-danger">{environments.error.message}</p>
        )}
        {!environments.isPending && available.length === 0 && (
          <div className="text-xs text-fg-muted">
            <p>
              {environments.data?.items
                .flatMap((item) => item.reasons)
                .join(" ") || "No environment is available to run workflows."}
            </p>
            <button
              type="button"
              className="workflow-text-action mt-2"
              onClick={() => void environments.refetch()}
            >
              Check again
            </button>
          </div>
        )}
        <div className="flex justify-between items-center">
          <h3 className="text-xs font-medium">Starting information</h3>
          <button
            type="button"
            className="workflow-text-action"
            onClick={() => {
              if (!jsonMode) {
                try {
                  setJson(
                    JSON.stringify(
                      parseWorkflowInput({ parameters, values }),
                      null,
                      2,
                    ),
                  );
                } catch {
                  setJson("{}");
                }
              }
              setJsonMode(!jsonMode);
            }}
          >
            {jsonMode ? "Use fields" : "Use JSON"}
          </button>
        </div>
        {jsonMode ? (
          <label className="workflow-field">
            <span className="sr-only">Run input JSON</span>
            <textarea
              value={json}
              onChange={(event) => setJson(event.target.value)}
              rows={6}
              spellCheck={false}
              className="font-mono"
            />
          </label>
        ) : (
          parameters.map((param) => {
            const options = enumValues(param);
            return (
              <label
                key={param.name}
                htmlFor={`${formId}-${param.name}`}
                className="workflow-field"
              >
                <span>
                  {param.displayName ?? friendlyParamName(param.name)}
                  {param.optional || param.defaultValue != null ? (
                    <span className="ml-2 text-fg-faint font-normal">
                      Optional
                    </span>
                  ) : null}
                </span>
                {options || param.type === "boolean" ? (
                  <select
                    id={`${formId}-${param.name}`}
                    value={values[param.name] ?? ""}
                    onChange={(event) =>
                      setValues({ ...values, [param.name]: event.target.value })
                    }
                  >
                    <option value="">Choose a value</option>
                    {(options ?? [true, false]).map((option) => (
                      <option value={String(option)} key={String(option)}>
                        {option === true
                          ? "Yes"
                          : option === false
                            ? "No"
                            : option}
                      </option>
                    ))}
                  </select>
                ) : ["string", "number"].includes(param.type) ? (
                  <input
                    type={param.type === "number" ? "number" : "text"}
                    step="any"
                    id={`${formId}-${param.name}`}
                    value={values[param.name] ?? ""}
                    onChange={(event) =>
                      setValues({ ...values, [param.name]: event.target.value })
                    }
                  />
                ) : (
                  <textarea
                    rows={3}
                    placeholder="JSON value"
                    id={`${formId}-${param.name}`}
                    value={values[param.name] ?? ""}
                    onChange={(event) =>
                      setValues({ ...values, [param.name]: event.target.value })
                    }
                  />
                )}
                {param.description && (
                  <span className="text-fg-muted font-normal">
                    {param.description}
                  </span>
                )}
              </label>
            );
          })
        )}
        {!jsonMode && parameters.length === 0 && (
          <p className="text-xs text-fg-muted">
            {published.data
              ? "No information is required."
              : "Inputs appear after this workflow is published."}
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        <PendingButton
          type="submit"
          className="workflow-primary"
          pending={trigger.isPending}
          pendingLabel="Starting…"
          disabled={Boolean(blocked) || deploy.isPending}
          data-disabled-reason={
            deploy.isPending ? "Wait for publishing to finish" : blocked
          }
        >
          <span className="inline-flex items-center gap-1.5">
            <Play className="size-3.5" /> Start run
          </span>
        </PendingButton>
        {blocked && <p className="text-xs text-fg-muted">{blocked}.</p>}
      </form>
      <WorkflowSection title="Recent runs">
        {runs.isPending && <p className="text-fg-muted">Loading runs…</p>}
        {runs.error && (
          <div className="text-danger">
            <p>{runs.error.message}</p>
            <button
              type="button"
              className="workflow-text-action mt-2"
              onClick={() => void runs.refetch()}
            >
              Try again
            </button>
          </div>
        )}
        {runs.data?.items.length === 0 && (
          <p className="text-fg-muted">Your run history will appear here.</p>
        )}
        {runs.data?.items.map((run) => (
          <div key={run.id} className="border-b border-border">
            <button
              type="button"
              className="workflow-run-row"
              aria-expanded={selected === run.id}
              onClick={() =>
                setSelected(selected === run.id ? undefined : run.id)
              }
            >
              <span>
                <span className="block capitalize">
                  {run.status === "waiting" && run.phase === "pause"
                    ? "Waiting for input"
                    : run.status.replaceAll("_", " ")}
                </span>
                <span className="block text-fg-muted text-[11px] mt-1">
                  {new Date(run.createdAt).toLocaleString()}
                </span>
              </span>
              <ChevronDown
                className={`size-3.5 transition-transform duration-200 ${selected === run.id ? "rotate-180" : ""}`}
              />
            </button>
            {selected === run.id && <RunDetail runId={run.id} />}
          </div>
        ))}
      </WorkflowSection>
    </div>
  );
}
