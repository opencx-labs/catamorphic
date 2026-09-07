import {
  activePanelTabAtom,
  codeAtom,
  graphAtom,
  graphParseStateAtom,
  rightPanelOpenAtom,
  selectedNodeAtom,
  useOnParse,
  useProjectFile,
  useWorkflow,
  useWorkflowGraph,
  useWorkflows,
  useWriteProjectFile,
} from "@catamorphic/react";
import type { WorkflowNode } from "@catamorphic/react/types";
import {
  friendlyParamName,
  WorkflowCanvas,
  WorkflowEditorScope,
} from "@catamorphic/ui";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  Check,
  ChevronRight,
  Code2,
  LoaderCircle,
  PanelRight,
  Play,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MonacoCodeEditor } from "../components/catamorphic/monaco-editor.js";
import { Collapsible } from "../components/collapsible.js";
import { PendingButton } from "../components/pending-button.js";
import { ShortcutHint } from "../components/shortcut-hint.js";
import { WorkflowDetails } from "../components/workflow-details.js";
import { WorkflowEnablementPanel } from "../components/workflow-enablement-panel.js";
import { WorkflowRuns } from "../components/workflow-runs.js";
import type { WorkflowDraft } from "../components/workspace-tabs.js";
import { desktopApi } from "../lib/desktop-api.js";
import { useTheme } from "../lib/theme.js";
import "../lib/monaco-setup.js";
import "./workflow-screen.css";

interface WorkflowScreenProps {
  projectId: string;
  workflowName: string;
  canEdit: boolean;
  active: boolean;
  onAskAgent: (message: string) => void;
  onOpenSource: (path: string, line?: number, column?: number) => void;
  initialDraft?: WorkflowDraft;
  onDraftChange: (draft: WorkflowDraft | undefined) => void;
}

export function WorkflowScreen(props: WorkflowScreenProps) {
  const { projectId, workflowName } = props;
  const workflows = useWorkflows(projectId);
  const summary = workflows.data?.find(
    (workflow) => workflow.name === workflowName,
  );
  // Keep an already-open source editable even when an incomplete save makes
  // workflow discovery temporarily miss its export.
  const discoveredPath = summary?.filePath.replace(/^\/+/, "");
  const knownPath = useRef(discoveredPath ?? props.initialDraft?.filePath);
  if (discoveredPath) knownPath.current = discoveredPath;
  const filePath = discoveredPath ?? knownPath.current;
  const file = useProjectFile(projectId, filePath, {
    refetchInterval: props.active ? 1500 : false,
  });
  useEffect(
    () =>
      desktopApi.onGitChanged((event) => {
        if (event.projectId === projectId && filePath) void file.refetch();
      }),
    [projectId, filePath, file.refetch],
  );
  if ((workflows.isPending && !filePath) || (filePath && file.isPending))
    return (
      <div className="grid flex-1 place-items-center">
        <p className="text-sm text-fg-muted">Loading workflow…</p>
      </div>
    );
  if (!filePath || !file.data)
    return (
      <div className="grid flex-1 place-items-center">
        <div className="max-w-sm space-y-3 text-center text-sm text-fg-muted">
          <p>
            {file.error?.message ??
              workflows.error?.message ??
              `Workflow “${workflowName}” was not found in this project.`}
          </p>
          <button
            type="button"
            className="workflow-secondary"
            onClick={() => {
              void workflows.refetch();
              if (filePath) void file.refetch();
            }}
          >
            Try again
          </button>
        </div>
      </div>
    );
  return (
    <WorkflowEditorScope>
      <WorkflowWorkbench
        {...props}
        filePath={filePath}
        diskCode={file.data.content}
        refreshFile={file.refetch}
      />
    </WorkflowEditorScope>
  );
}

function WorkflowWorkbench({
  projectId,
  workflowName,
  canEdit,
  active,
  filePath,
  diskCode,
  refreshFile,
  onAskAgent,
  onOpenSource,
  initialDraft,
  onDraftChange,
}: WorkflowScreenProps & {
  filePath: string;
  diskCode: string;
  refreshFile: ReturnType<typeof useProjectFile>["refetch"];
}) {
  const theme = useTheme();
  const workflow = useWorkflow(projectId, workflowName, {
    refetchInterval: active ? 2000 : false,
  });
  const [buffer, setBuffer] = useState(() =>
    initialDraft?.filePath === filePath
      ? { code: initialDraft.code, baseline: initialDraft.baseline }
      : { code: diskCode, baseline: diskCode },
  );
  const dirty = buffer.code !== buffer.baseline;
  const conflict = diskCode !== buffer.baseline && diskCode !== buffer.code;
  useEffect(() => {
    setBuffer((current) =>
      current.code === current.baseline || current.code === diskCode
        ? { code: diskCode, baseline: diskCode }
        : current,
    );
  }, [diskCode]);
  const draftCallback = useRef(onDraftChange);
  draftCallback.current = onDraftChange;
  useEffect(() => {
    draftCallback.current(dirty ? { ...buffer, filePath } : undefined);
  }, [buffer, dirty, filePath]);
  const setScopeCode = useSetAtom(codeAtom);
  useEffect(() => {
    setScopeCode(buffer.code);
  }, [buffer.code, setScopeCode]);
  const onParse = useOnParse({
    files: workflow.data?.allFiles ?? {},
    workflowName,
    preferredFilePath: filePath,
  });
  const { buildGraph } = useWorkflowGraph({ onParse });
  // Changes in imported helpers also change the graph, without touching this buffer.
  const previousFiles = useRef(workflow.data?.allFiles);
  useEffect(() => {
    if (previousFiles.current !== workflow.data?.allFiles) {
      previousFiles.current = workflow.data?.allFiles;
      void buildGraph(buffer.code);
    }
  }, [workflow.data?.allFiles, buildGraph, buffer.code]);
  const graph = useAtomValue(graphAtom);
  const parse = useAtomValue(graphParseStateAtom);
  const node = useAtomValue(selectedNodeAtom);
  const [open, setOpen] = useAtom(rightPanelOpenAtom);
  const [tab, setTab] = useAtom(activePanelTabAtom);
  const [extra, setExtra] = useState<"runs" | "automate" | "edit" | null>(null);
  const [request, setRequest] = useState("");
  const requestInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (extra === "edit") requestInput.current?.focus();
  }, [extra]);
  const [editNode, setEditNode] = useState<WorkflowNode>();
  const write = useWriteProjectFile(projectId);
  const [saveError, setSaveError] = useState<string>();
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setOpen(true);
  }, [setOpen]);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 1500);
    return () => clearTimeout(timer);
  }, [saved]);
  // Selecting a node from the canvas reveals its details, except while the
  // user deliberately keeps source code beside the graph.
  useEffect(() => {
    if (node?.id) setExtra(null);
  }, [node?.id]);
  const save = useCallback(async () => {
    if (!canEdit || write.isPending || !dirty) return;
    setSaveError(undefined);
    const snapshot = buffer;
    try {
      const latest = await refreshFile();
      if (latest.error) throw latest.error;
      if (
        latest.data?.content !== snapshot.baseline &&
        latest.data?.content !== snapshot.code
      )
        throw new Error(
          "This file changed while you were editing. Review the latest file before saving.",
        );
      await write.mutateAsync({ path: filePath, content: snapshot.code });
      setBuffer((current) => ({ ...current, baseline: snapshot.code }));
      setSaved(true);
    } catch (cause) {
      setSaveError(
        cause instanceof Error ? cause.message : "Could not save your changes.",
      );
    }
  }, [buffer, dirty, filePath, refreshFile, write, canEdit]);
  const viewCode = () => {
    const source = node?.sourceRange;
    if (
      source?.file &&
      source.file.replace(/^\//, "") !== filePath.replace(/^\//, "")
    ) {
      onOpenSource(source.file, source.startLine, source.startColumn);
      return;
    }
    setExtra(null);
    setTab("code");
    setOpen(true);
  };
  const show = (view: "details" | "code" | "runs" | "automate") => {
    if (view === "details" || view === "code") {
      setExtra(null);
      setTab(view);
    } else setExtra(view);
    setOpen(true);
  };
  const ask = (selected?: WorkflowNode) => {
    setEditNode(selected);
    setExtra("edit");
    setOpen(true);
  };
  const currentView = extra ?? tab;
  return (
    <section
      aria-label="Workflow workspace"
      className="workflow-workbench"
      data-testid="workflow-workbench"
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          event.stopPropagation();
          void save();
        }
      }}
    >
      <header className="workflow-header">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[13px] font-semibold">
            {graph?.displayName ?? friendlyParamName(workflowName)}
          </h1>
          <div
            className="mt-0.5 flex items-center gap-1.5 text-[11px] text-fg-muted"
            role="status"
          >
            {parse.status === "updating" ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : parse.status === "ready" ? (
              <Check className="size-3" />
            ) : null}
            <span>
              {parse.status === "error"
                ? "Preview needs attention"
                : parse.status === "updating"
                  ? "Updating preview…"
                  : dirty
                    ? "Unsaved changes"
                    : "Saved to project"}
            </span>
          </div>
        </div>
        <div className="workflow-header-actions">
          <PendingButton
            type="button"
            className="workflow-secondary"
            pending={write.isPending}
            done={saved && !dirty}
            doneLabel="Saved"
            disabled={!canEdit || !dirty || conflict}
            data-disabled-reason={
              !canEdit
                ? "Only project builders can save workflow changes"
                : conflict
                  ? "The file changed on disk. Review it before saving"
                  : "No unsaved changes"
            }
            onClick={() => void save()}
          >
            Save
          </PendingButton>
          <button
            type="button"
            className="workflow-secondary"
            onClick={() => show("automate")}
          >
            Automate
          </button>
          <button
            type="button"
            className="workflow-primary"
            onClick={() => show("runs")}
          >
            <Play className="size-3.5" /> Run
          </button>
          <ShortcutHint
            label={open ? "Hide workflow inspector" : "Show workflow inspector"}
          >
            <button
              type="button"
              className="workflow-icon-button"
              aria-label={
                open ? "Hide workflow inspector" : "Show workflow inspector"
              }
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              <PanelRight className="size-4" />
            </button>
          </ShortcutHint>
        </div>
      </header>
      <Collapsible
        open={parse.status === "error" || Boolean(saveError) || conflict}
      >
        <div className="workflow-notice" role="status">
          <p>
            {saveError ??
              (conflict
                ? "This file changed on disk. Your draft is preserved."
                : `${graph ? "Showing the last valid preview. " : ""}${parse.error ?? "Check the workflow code."}`)}
          </p>
          <div className="flex shrink-0 gap-3">
            <button
              type="button"
              className="workflow-text-action"
              onClick={viewCode}
            >
              View code
            </button>
            {conflict ? (
              <button
                type="button"
                className="workflow-text-action"
                onClick={() => {
                  setBuffer({ code: diskCode, baseline: diskCode });
                  setSaveError(undefined);
                }}
              >
                Use disk version
              </button>
            ) : (
              <button
                type="button"
                className="workflow-text-action"
                onClick={() => void buildGraph(buffer.code)}
              >
                Retry preview
              </button>
            )}
          </div>
        </div>
      </Collapsible>
      <div
        className="workflow-stage"
        data-inspector-open={open}
        data-inspector-view={currentView}
      >
        <div className="workflow-graph">
          <WorkflowCanvas />
          {!graph && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center px-8 text-center text-xs text-fg-muted">
              <p>
                {parse.status === "updating"
                  ? "Preparing your workflow preview…"
                  : "Open Code to create or repair this workflow."}
              </p>
            </div>
          )}
        </div>
        <aside
          className="workflow-inspector"
          aria-label="Workflow inspector"
          aria-hidden={!open}
          inert={!open}
        >
          <div className="workflow-inspector-inner">
            <nav
              className="workflow-inspector-tabs"
              aria-label="Workflow views"
            >
              {(["details", "code", "runs"] as const).map((view) => (
                <button
                  type="button"
                  key={view}
                  aria-current={currentView === view ? "page" : undefined}
                  onClick={() => show(view)}
                >
                  {view === "details"
                    ? "Details"
                    : view === "code"
                      ? "Code"
                      : "Runs"}
                </button>
              ))}
              <span className="ml-auto">
                <ShortcutHint label="Close inspector">
                  <button
                    type="button"
                    className="workflow-icon-button"
                    aria-label="Close inspector"
                    onClick={() => setOpen(false)}
                  >
                    <X className="size-3.5" />
                  </button>
                </ShortcutHint>
              </span>
            </nav>
            <div className="workflow-inspector-content">
              {currentView === "details" && (
                <WorkflowDetails
                  canEdit={canEdit}
                  filePath={filePath}
                  onCode={viewCode}
                  onAskAgent={ask}
                  onAutomate={() => show("automate")}
                />
              )}
              {currentView === "code" && (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="workflow-source-header">
                    <span className="truncate font-mono text-[11px] text-fg-muted">
                      {filePath}
                    </span>
                    <ShortcutHint label="Open source in editor">
                      <button
                        type="button"
                        className="workflow-icon-button"
                        aria-label="Open source in editor"
                        disabled={dirty}
                        data-disabled-reason="Save your draft before opening it in another editor"
                        onClick={() =>
                          onOpenSource(
                            filePath,
                            node?.sourceRange.startLine,
                            node?.sourceRange.startColumn,
                          )
                        }
                      >
                        <Code2 className="size-3.5" />
                      </button>
                    </ShortcutHint>
                  </div>
                  <div className="min-h-0 flex-1">
                    <MonacoCodeEditor
                      code={buffer.code}
                      readOnly={!canEdit}
                      onChange={(code) => {
                        setSaved(false);
                        setBuffer((current) => ({ ...current, code }));
                      }}
                      path={`file:///${projectId}/${filePath}`}
                      theme={
                        theme?.appearance === "light" ? "light" : "vs-dark"
                      }
                    />
                  </div>
                </div>
              )}
              {currentView === "runs" && (
                <WorkflowRuns
                  projectId={projectId}
                  workflowName={workflowName}
                  dirty={dirty}
                  canPublish={canEdit}
                />
              )}
              {currentView === "automate" && (
                <WorkflowEnablementPanel
                  projectId={projectId}
                  workflowName={workflowName}
                  onClose={() => show("details")}
                  inline
                />
              )}
              {currentView === "edit" && (
                <form
                  className="workflow-detail-body"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!request.trim() || dirty) return;
                    onAskAgent(
                      `Edit workflow ${workflowName} in ${filePath}.${editNode ? ` Focus on the step “${editNode.label}” near line ${editNode.sourceRange.startLine}.` : ""}\n\n${request.trim()}\n\nKeep TypeScript as the source of truth and return a [workflow link](workflow:${workflowName}) when ready.`,
                    );
                    setRequest("");
                    show("details");
                  }}
                >
                  <h2 className="text-base font-semibold">Describe a change</h2>
                  <p className="mt-2 text-[13px] text-fg-muted leading-relaxed">
                    {editNode
                      ? `Your agent will work on “${editNode.label}” in this workflow.`
                      : "Your agent will edit the workflow code. Follow the changes here as the graph updates."}
                  </p>
                  <label className="workflow-field mt-5">
                    <span>What should change?</span>
                    <textarea
                      ref={requestInput}
                      rows={6}
                      placeholder="For example, ask for approval before sending the report."
                      value={request}
                      onChange={(event) => setRequest(event.target.value)}
                    />
                  </label>
                  {dirty && (
                    <p className="mt-3 text-xs text-fg-muted">
                      Save your edits before asking the agent to change this
                      file.
                    </p>
                  )}
                  <div className="mt-4 flex gap-2">
                    <PendingButton
                      pending={false}
                      type="submit"
                      className="workflow-primary"
                      disabled={!request.trim() || dirty}
                      data-disabled-reason={
                        dirty
                          ? "Save your edits first"
                          : "Describe the change first"
                      }
                    >
                      <span className="inline-flex items-center gap-1.5">
                        Ask agent <ChevronRight className="size-3.5" />
                      </span>
                    </PendingButton>
                    <button
                      type="button"
                      className="workflow-secondary"
                      onClick={() => show("details")}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
