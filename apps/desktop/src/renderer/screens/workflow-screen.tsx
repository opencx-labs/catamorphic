import {
  codeAtom,
  graphAtom,
  graphParseStateAtom,
  selectedNodeAtom,
  selectedNodeIdAtom,
  useOnParse,
  useProjectFile,
  useWorkflow,
  useWorkflowEnablements,
  useWorkflowGraph,
  useWorkflows,
  useWriteProjectFile,
} from "@catamorphic/react";
import type { WorkflowNode } from "@catamorphic/react/types";
import {
  friendlyParamName,
  WorkflowCanvas,
  WorkflowEditorScope,
  WorkflowReview,
} from "@catamorphic/ui";
import { useAtomValue, useSetAtom } from "jotai";
import { ChevronRight, Code2, ExternalLink, Play, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PendingChatMessage } from "../../shared/chat.js";
import { MonacoCodeEditor } from "../components/catamorphic/monaco-editor.js";
import { PendingButton } from "../components/pending-button.js";
import {
  ProjectAuthorityProvider,
  useRemoteAuthority,
} from "../components/project-authority-provider.js";
import { ShortcutHint } from "../components/shortcut-hint.js";
import {
  stepKind,
  WorkflowStepDetails,
} from "../components/workflow-details.js";
import { WorkflowEnablementPanel } from "../components/workflow-enablement-panel.js";
import {
  useWorkflowPublication,
  WorkflowPublishCallout,
} from "../components/workflow-publish.js";
import { WorkflowRuns } from "../components/workflow-runs.js";
import {
  type WorkflowAutomation,
  type WorkflowProblem,
  WorkflowStatus,
} from "../components/workflow-status.js";
import type { WorkflowDraft } from "../components/workspace-tabs.js";
import { desktopApi } from "../lib/desktop-api.js";
import { useMonacoTheme } from "../lib/monaco-setup.js";
import { useTheme } from "../lib/theme.js";
import "./workflow-screen.css";

interface WorkflowScreenProps {
  projectId: string;
  workflowName: string;
  canEdit: boolean;
  active: boolean;
  onAskAgent: (message: PendingChatMessage) => void;
  onOpenSource: (path: string, line?: number, column?: number) => void;
  initialDraft?: WorkflowDraft;
  onDraftChange: (draft: WorkflowDraft | undefined) => void;
}

/** What the side panel is showing. Nothing is open until there is a subject. */
type PanelView = "step" | "code" | "runs" | "automation" | "change";

const PANEL_TITLES: Record<Exclude<PanelView, "step">, string> = {
  code: "Code",
  runs: "Run",
  automation: "Automatic runs",
  change: "Describe a change",
};

export function WorkflowScreen(props: WorkflowScreenProps) {
  return (
    <ProjectAuthorityProvider projectId={props.projectId}>
      <WorkflowScreenContent {...props} />
    </ProjectAuthorityProvider>
  );
}

function WorkflowScreenContent(props: WorkflowScreenProps) {
  const authority = useRemoteAuthority();
  if (!(authority ? authority.writesProgram : props.canEdit))
    return (
      <WorkflowReview
        projectId={props.projectId}
        workflowName={props.workflowName}
        showTitle={false}
      />
    );
  return <WorkflowAuthoringScreen {...props} />;
}

function WorkflowAuthoringScreen(props: WorkflowScreenProps) {
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
              `“${friendlyParamName(workflowName)}” was not found in this project.`}
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
  const editorTheme = useMonacoTheme();
  const workflow = useWorkflow(projectId, workflowName, {
    refetchInterval: active ? 2000 : false,
  });
  const [buffer, setBuffer] = useState(() =>
    initialDraft?.filePath === filePath
      ? { code: initialDraft.code, baseline: initialDraft.baseline }
      : { code: diskCode, baseline: diskCode },
  );
  const dirty = buffer.code !== buffer.baseline;
  // Only a draft can conflict; a clean buffer follows the disk (the effect
  // below catches up one render after the file changes).
  const conflict =
    dirty && diskCode !== buffer.baseline && diskCode !== buffer.code;
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
  const select = useSetAtom(selectedNodeIdAtom);
  const write = useWriteProjectFile(projectId);
  const [saveError, setSaveError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [statusRequest, setStatusRequest] = useState(0);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 1500);
    return () => clearTimeout(timer);
  }, [saved]);

  // The panel opens for a subject and closes with it. Selecting a step shows
  // its details, except while code is kept beside the graph: the editor
  // follows the selection there instead.
  const [view, setView] = useState<PanelView | null>(null);
  const [changeNode, setChangeNode] = useState<WorkflowNode>();
  const lastView = useRef<PanelView>("step");
  if (view) lastView.current = view;
  const shownView = view ?? lastView.current;
  const lastNode = useRef(node);
  if (node) lastNode.current = node;
  const shownNode = node ?? lastNode.current;
  useEffect(() => {
    if (node?.id)
      setView((current) =>
        current === "code" || current === "change" ? current : "step",
      );
    else setView((current) => (current === "step" ? null : current));
  }, [node?.id]);
  // A change request follows the selection: pick another step to retarget
  // it, or clear the selection to describe a change to the whole workflow.
  useEffect(() => {
    if (view === "change") setChangeNode(node ?? undefined);
  }, [view, node]);
  const closePanel = useCallback(() => {
    setView(null);
    select(null);
  }, [select]);
  const show = (next: PanelView) => {
    if (next === "runs" || next === "automation") select(null);
    setView(next);
  };

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
      setStatusRequest((value) => value + 1);
    }
  }, [buffer, dirty, filePath, refreshFile, write, canEdit]);

  const viewCode = (target?: WorkflowNode | null) => {
    const source = target?.sourceRange;
    if (
      source?.file &&
      source.file.replace(/^\//, "") !== filePath.replace(/^\//, "")
    ) {
      onOpenSource(source.file, source.startLine, source.startColumn);
      return;
    }
    setView("code");
  };
  const openInEditor = () =>
    onOpenSource(
      filePath,
      node?.sourceRange.startLine,
      node?.sourceRange.startColumn,
    );
  const describeChange = (target?: WorkflowNode) => {
    setChangeNode(target);
    if (!target) select(null);
    show("change");
  };

  // Automatic runs only mean something when the code declares triggers.
  const triggerCount =
    graph?.nodes.find((item) => item.type === "input")?.triggerBindings
      ?.length ??
    graph?.triggers.length ??
    0;
  const enablements = useWorkflowEnablements(
    triggerCount > 0 ? projectId : undefined,
    workflowName,
  );
  // Any active enablement (yours or the project's) means it runs on its own.
  const enablement =
    enablements.data?.items.find((item) => item.status === "active") ??
    enablements.data?.items[0];
  const automation: WorkflowAutomation =
    triggerCount === 0
      ? { kind: "none" }
      : enablements.isPending
        ? { kind: "loading" }
        : !enablement
          ? { kind: "off" }
          : enablement.status === "active"
            ? {
                kind: "on",
                updateAvailable: enablement.updateAvailable,
                forProject: enablement.owner.type === "project",
              }
            : {
                kind: "paused",
                reason:
                  enablement.status === "suspended"
                    ? "Needs attention"
                    : "Paused",
              };

  const problem: WorkflowProblem | undefined = saveError
    ? {
        message: saveError,
        actions: [{ label: "View code", onClick: () => viewCode() }],
      }
    : conflict
      ? {
          message:
            "This file changed on disk while you were editing. Your draft is kept until you choose.",
          actions: [
            { label: "View code", onClick: () => viewCode() },
            {
              label: "Use disk version",
              onClick: () => {
                setBuffer({ code: diskCode, baseline: diskCode });
                setSaveError(undefined);
              },
            },
          ],
        }
      : parse.status === "error"
        ? {
            message: `${graph ? "Showing the last valid version. " : ""}${parse.error ?? "Check the workflow code."}`,
            actions: [
              { label: "View code", onClick: () => viewCode() },
              {
                label: "Retry preview",
                onClick: () => void buildGraph(buffer.code),
              },
            ],
          }
        : undefined;
  // A decision only the user can make (a failed save, a file changed under
  // the draft) opens the status popover.
  useEffect(() => {
    if (conflict) setStatusRequest((value) => value + 1);
  }, [conflict]);

  const panelTitle =
    shownView === "step"
      ? shownNode
        ? stepKind(shownNode)
        : "Step"
      : PANEL_TITLES[shownView];
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
          return;
        }
        if (
          event.key === "Escape" &&
          view &&
          !(
            event.target instanceof Element &&
            event.target.closest("input, textarea, select, .monaco-editor")
          )
        ) {
          event.stopPropagation();
          closePanel();
        }
      }}
    >
      <div
        className="workflow-stage"
        data-panel-open={Boolean(view)}
        data-panel-view={shownView}
      >
        <div className="workflow-graph">
          <WorkflowCanvas />
          {!graph && (
            <div className="workflow-empty">
              <p>
                {parse.status === "error"
                  ? "This workflow can’t be shown yet."
                  : "Preparing the workflow…"}
              </p>
              {parse.status === "error" && (
                <button
                  type="button"
                  className="workflow-secondary"
                  onClick={() => viewCode()}
                >
                  <Code2 className="size-3.5" /> View code
                </button>
              )}
            </div>
          )}
          <div
            className="workflow-controls"
            data-testid="workflow-status-controls"
          >
            <WorkflowStatus
              graph={graph}
              workflowName={workflowName}
              filePath={filePath}
              saving={write.isPending}
              dirty={dirty}
              conflict={conflict}
              preview={parse.status}
              problem={problem}
              automation={automation}
              canEdit={canEdit}
              openRequest={statusRequest || undefined}
              onDescribeChange={() => describeChange()}
              onCode={() => viewCode()}
              onOpenInEditor={openInEditor}
              openInEditorDisabledReason={
                dirty
                  ? "Save your draft before opening it in another editor"
                  : undefined
              }
              onRuns={() => show("runs")}
              onAutomation={() => show("automation")}
            />
            {(dirty || (saved && !dirty)) && (
              <PendingButton
                type="button"
                className="workflow-control"
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
            )}
            <ShortcutHint label={view === "code" ? "Hide code" : "Show code"}>
              <button
                type="button"
                className="workflow-control workflow-control-icon"
                aria-label="Code"
                aria-pressed={view === "code"}
                onClick={() => (view === "code" ? closePanel() : viewCode())}
              >
                <Code2 className="size-3.5" />
              </button>
            </ShortcutHint>
            <button
              type="button"
              className="workflow-control"
              aria-pressed={view === "runs"}
              onClick={() => (view === "runs" ? closePanel() : show("runs"))}
            >
              <Play className="size-3" /> Run
            </button>
          </div>
        </div>
        <aside
          className="workflow-panel"
          aria-label={panelTitle}
          aria-hidden={!view}
          inert={!view}
          data-testid="workflow-panel"
        >
          <div className="workflow-panel-inner">
            <header className="workflow-panel-header">
              <h2>{panelTitle}</h2>
              {shownView === "code" && (
                <>
                  <span className="min-w-0 truncate font-mono text-[11px] text-fg-faint">
                    {filePath}
                  </span>
                  <ShortcutHint label="Open in editor">
                    <button
                      type="button"
                      className="workflow-icon-button"
                      aria-label="Open in editor"
                      aria-disabled={dirty}
                      data-disabled-reason={
                        dirty
                          ? "Save your draft before opening it in another editor"
                          : undefined
                      }
                      onClick={() => {
                        if (!dirty) openInEditor();
                      }}
                    >
                      <ExternalLink className="size-3.5" />
                    </button>
                  </ShortcutHint>
                </>
              )}
              <span className="flex-1" />
              <ShortcutHint label="Close" shortcut="Esc">
                <button
                  type="button"
                  className="workflow-icon-button"
                  aria-label={`Close ${panelTitle.toLowerCase()}`}
                  onClick={closePanel}
                >
                  <X className="size-3.5" />
                </button>
              </ShortcutHint>
            </header>
            <div className="workflow-panel-content">
              {shownView === "step" && shownNode && (
                <WorkflowStepDetails
                  node={shownNode}
                  canEdit={canEdit}
                  onCode={() => viewCode(shownNode)}
                  onAskAgent={describeChange}
                />
              )}
              {shownView === "code" && (
                <div className="min-h-0 flex-1">
                  <MonacoCodeEditor
                    code={buffer.code}
                    readOnly={!canEdit}
                    onChange={(code) => {
                      setSaved(false);
                      setBuffer((current) => ({ ...current, code }));
                    }}
                    path={`file:///${projectId}/${filePath}`}
                    fontFamily={theme?.fonts.mono}
                    theme={editorTheme}
                  />
                </div>
              )}
              {shownView === "runs" && (
                <WorkflowRuns
                  projectId={projectId}
                  workflowName={workflowName}
                  dirty={dirty}
                  canPublish={canEdit}
                />
              )}
              {shownView === "automation" && (
                <AutomaticRuns
                  projectId={projectId}
                  workflowName={workflowName}
                  dirty={dirty}
                  canPublish={canEdit}
                />
              )}
              {shownView === "change" && (
                <ChangeRequest
                  open={view === "change"}
                  node={changeNode}
                  dirty={dirty}
                  onCancel={closePanel}
                  onSubmit={(request) => {
                    const title =
                      graph?.displayName ?? friendlyParamName(workflowName);
                    onAskAgent({
                      text: request,
                      attachments: [
                        {
                          kind: "text",
                          name: filePath.split("/").at(-1) ?? filePath,
                          source: { type: "path", path: filePath },
                          text: filePath,
                        },
                        {
                          kind: "text",
                          name: changeNode
                            ? `${title}: ${changeNode.label}`
                            : title,
                          source: { type: "paste" },
                          text: [
                            `Change the workflow “${title}” (export \`${workflowName}\`) in ${filePath}.`,
                            changeNode
                              ? `Focus on the step “${changeNode.label}” near line ${changeNode.sourceRange.startLine}.`
                              : "",
                            `Keep TypeScript as the source of truth. The open workflow tab updates its graph as you save. When the change is ready, link it as [${title}](workflow:${workflowName}).`,
                          ]
                            .filter(Boolean)
                            .join(" "),
                        },
                      ],
                    });
                    closePanel();
                  }}
                />
              )}
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}

/** Automatic runs start the published version, so publishing comes first. */
function AutomaticRuns({
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
  const publication = useWorkflowPublication({
    projectId,
    workflowName,
    dirty,
    canPublish,
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {(publication.missing || publication.unpublished) && (
        <div className="px-5 pt-5">
          <WorkflowPublishCallout
            publication={publication}
            purpose="automatic"
          />
        </div>
      )}
      {!publication.missing && (
        <WorkflowEnablementPanel
          projectId={projectId}
          workflowName={workflowName}
          onClose={() => {}}
          inline
        />
      )}
    </div>
  );
}

function ChangeRequest({
  open,
  node,
  dirty,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  node?: WorkflowNode;
  dirty: boolean;
  onCancel: () => void;
  onSubmit: (request: string) => void;
}) {
  const [request, setRequest] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  const blocked = dirty
    ? "Save your edits before asking the agent to change this file"
    : !request.trim()
      ? "Describe the change first"
      : undefined;
  return (
    <form
      className="workflow-detail-body"
      onSubmit={(event) => {
        event.preventDefault();
        if (!blocked) onSubmit(request.trim());
      }}
    >
      <p className="text-[13px] leading-relaxed text-fg-muted">
        {node
          ? `Your agent will change “${node.label}” and the graph will update here as it works.`
          : "Your agent will change this workflow and the graph will update here as it works."}
      </p>
      <label className="workflow-field mt-5">
        <span>What should change?</span>
        <textarea
          ref={input}
          rows={6}
          placeholder="For example, ask for approval before sending the report."
          value={request}
          onChange={(event) => setRequest(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (!blocked) onSubmit(request.trim());
            }
          }}
        />
      </label>
      {dirty && (
        <p className="mt-3 text-xs text-fg-muted">
          Save your edits before asking the agent to change this file.
        </p>
      )}
      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          className="workflow-primary"
          aria-disabled={Boolean(blocked)}
          data-disabled-reason={blocked}
        >
          Ask agent <ChevronRight className="size-3.5" />
        </button>
        <button type="button" className="workflow-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
