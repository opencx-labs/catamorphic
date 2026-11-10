import { PROJECT_PERSONAL_DIR } from "@catamorphic/workflow/project-layout";
import Editor, { type OnMount } from "@monaco-editor/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, FileText } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ActionInputDialog } from "../components/action-input-dialog.js";
import { FileInspector } from "../components/file-inspector.js";
import { FileSaveButton } from "../components/file-save-button.js";
import {
  moveFocusAsApp,
  personInputCount,
  personMovedOn,
} from "../lib/app-focus.js";
import { desktopApi } from "../lib/desktop-api.js";
import {
  notifyEditorSelectionChange,
  registerSelectionReader,
  stampSelectionOnClipboard,
} from "../lib/editor-selection.js";
import { localEditorPath } from "../lib/local-project-files.js";
import { useMonacoTheme } from "../lib/monaco-setup.js";
import { useTheme } from "../lib/theme.js";
import { useWorkspaceFlush } from "../lib/workspace-persistence.js";

/** Personal files show relative to the profile's own personal folder. */
const PERSONAL_PREFIX_PATTERN = new RegExp(
  `^(?:.*/)?${PROJECT_PERSONAL_DIR.replaceAll(".", "\\.")}/[^/]+/`,
);

/** The names Work gives the files it creates (Untitled.md, Untitled 2.md). */
const UNTITLED_NAME = /^Untitled(?: \d+)?\.[^./]+$/;

const baseName = (path: string) => path.split("/").at(-1) ?? path;
const withoutExtension = (name: string) => name.replace(/(?<=.)\.[^.]*$/, "");

/** A name for a new file from its first line ("# Plan" names it Plan). */
function suggestedName(content: string | undefined): string {
  const firstLine =
    content
      ?.split("\n")
      .map((line) =>
        line
          .replace(/^[#>\-*\s]+/, "")
          .replace(/[/\\:*?"<>|]/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .find(Boolean) ?? "";
  return firstLine.slice(0, 60).trim() || "Untitled";
}

type EditorInstance = Parameters<OnMount>[0];
type MonacoInstance = Parameters<OnMount>[1];

// Markdown files open in the rich markdown editor instead of Monaco — same
// tab kind, same drafts/save plumbing, different surface. Lazy so the
// tiptap chunk loads only when a markdown file is actually opened.
const MarkdownEditor = lazy(
  () => import("../components/markdown/markdown-editor.js"),
);

const isMarkdownPath = (path: string) => /\.(md|markdown)$/i.test(path);
const isOfficePath = (path: string) => /\.(docx?|pptx?|xlsx?)$/i.test(path);
const isPdfPath = (path: string) => /\.pdf$/i.test(path);

/**
 * A code editor tab: palette navigation over project files, Monaco on the
 * picked file (language inferred from the extension), Cmd+S / Save writes
 * through the embedded server's file API. One tab edits one file at a
 * time, but unsaved drafts survive switching files within the tab.
 */

export interface EditorScreenProps {
  projectId: string;
  /** Its pane occupies a slot in the visible workspace. */
  active: boolean;
  line?: number;
  column?: number;
  navigation?: string;
  /** Opening input count captured before this screen's lazy module loads. */
  autofocusSince?: number;
  /** Path of the open file (project-relative), or null for a palette entry point. */
  filePath: string | null;
  onFindFile: () => void;
  /** Any unsaved draft in this tab — surfaces as a dot on the tab icon. */
  onDirtyChange: (dirty: boolean) => void;
  onShare?: (filePath: string) => void;
  onPropose?: (filePath: string) => void;
  onSharePersonal?: (filePath: string, intent: "publish" | "propose") => void;
  /** The file was renamed: the tab follows it to its new path. */
  onRename?: (filePath: string) => void;
  renameRequest?: number;
  onSaveBeforeClose?: (save: (() => Promise<void>) | null) => void;
}

export function EditorScreen({
  projectId,
  active,
  line,
  column,
  navigation,
  autofocusSince,
  filePath,
  onFindFile,
  onDirtyChange,
  onShare,
  onPropose,
  onSharePersonal,
  onRename,
  renameRequest,
  onSaveBeforeClose,
}: EditorScreenProps) {
  const activeRef = useRef(active);
  activeRef.current = active;
  // Capture the opening intent before a file read or lazy editor can finish.
  // Unrelated renders must not renew permission to take the person's focus.
  const autofocusIntent = useRef({
    projectId,
    filePath,
    line,
    column,
    navigation,
    inputs: autofocusSince ?? personInputCount(),
  });
  if (
    autofocusIntent.current.projectId !== projectId ||
    autofocusIntent.current.filePath !== filePath ||
    autofocusIntent.current.line !== line ||
    autofocusIntent.current.column !== column ||
    autofocusIntent.current.navigation !== navigation
  ) {
    autofocusIntent.current = {
      projectId,
      filePath,
      line,
      column,
      navigation,
      inputs: autofocusSince ?? personInputCount(),
    };
  }
  const intent = autofocusIntent.current;
  const canAutofocus = () =>
    autofocusIntent.current === intent &&
    activeRef.current &&
    !personMovedOn(intent.inputs);
  const theme = useTheme();
  const editorTheme = useMonacoTheme();
  const officeFile = filePath ? isOfficePath(filePath) : false;
  const pdfFile = filePath ? isPdfPath(filePath) : false;
  const fileQuery = useQuery({
    queryKey: ["desktop-editor-file", projectId, filePath],
    enabled: Boolean(filePath) && !officeFile && !pdfFile,
    queryFn: async () =>
      desktopApi.editorFileRead({
        filePath: await localEditorPath(projectId, filePath ?? ""),
      }),
    retry: false,
    // A file changed outside Work shows once its window is back, as an
    // agent's change does (below); a draft keeps what it started from.
    refetchOnWindowFocus: () =>
      filePath ? draftsRef.current[filePath] === undefined : false,
  });
  const queryClient = useQueryClient();
  // One write at a time, including the interval before React renders pending.
  const writing = useRef<Promise<void> | null>(null);
  const writeFile = useMutation({
    mutationFn: async ({
      path,
      content,
      expectedContent,
    }: {
      path: string;
      content: string;
      expectedContent: string;
    }) =>
      desktopApi.editorFileWrite({
        filePath: await localEditorPath(projectId, path),
        content,
        expectedContent,
      }),
    onSuccess: async (_result, { path, content }) => {
      await queryClient.cancelQueries({
        queryKey: ["desktop-editor-file", projectId, path],
        exact: true,
      });
      // Advance the comparison baseline before a later edit can save. Refetching
      // here could return the previous content or overwrite a newer draft.
      queryClient.setQueryData(["desktop-editor-file", projectId, path], {
        content,
      });
      const current = draftsRef.current;
      if (current[path] === content) {
        const { [path]: _saved, ...rest } = current;
        draftsRef.current = rest;
        setDrafts(rest);
      }
    },
  });
  const editorRef = useRef<EditorInstance | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: repeated navigation to the same line must reveal it again
  useEffect(() => {
    if (!line || !editorRef.current) return;
    editorRef.current.setPosition({ lineNumber: line, column: column ?? 1 });
    editorRef.current.revealLineInCenter(line);
  }, [line, column, navigation]);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  useEffect(() => {
    if (!pdfFile || !filePath) {
      setPdfUrl(null);
      return;
    }
    let cancelled = false;
    setPdfError(null);
    let documentUrl: string | undefined;
    void desktopApi
      .pdfGuestDocument({ projectId, filePath })
      .then((url) => {
        documentUrl = url;
        if (cancelled) void desktopApi.appGuestClose({ url });
        else setPdfUrl(url);
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setPdfError(
            error instanceof Error
              ? error.message
              : "This PDF could not be opened. Try again.",
          );
      });
    return () => {
      cancelled = true;
      if (documentUrl) void desktopApi.appGuestClose({ url: documentUrl });
    };
  }, [filePath, pdfFile, projectId]);

  // Unsaved edits, kept per path so switching files within the tab never
  // drops work. A draft equal to the saved content is removed.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  // An agent's turn that changed the open file shows here once it settles.
  // A draft keeps the content it started from, so saving it still reports
  // the conflict.
  useEffect(
    () =>
      desktopApi.onGitChanged((event) => {
        if (event.projectId !== projectId || !filePath) return;
        if (draftsRef.current[filePath] !== undefined) return;
        void fileQuery.refetch();
      }),
    [projectId, filePath, fileQuery.refetch],
  );

  // Report only real transitions through a ref: the parent recreates the
  // callback each render, and a naive effect on it would loop forever.
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const dirty = Object.keys(drafts).length > 0;
  const prevDirtyRef = useRef(false);
  useEffect(() => {
    if (prevDirtyRef.current === dirty) return;
    prevDirtyRef.current = dirty;
    onDirtyChangeRef.current(dirty);
  }, [dirty]);

  const savedContent = fileQuery.data?.content;
  const draft = filePath ? drafts[filePath] : undefined;

  const handleChange = (next: string) => {
    if (!filePath || savedContent === undefined) return;
    // A read started while clean cannot change a draft's comparison base,
    // including after a save conflict with an agent's edit.
    if (draftsRef.current[filePath] === undefined)
      void queryClient.cancelQueries({
        queryKey: ["desktop-editor-file", projectId, filePath],
        exact: true,
      });
    if (writeFile.isError) writeFile.reset();
    const current = draftsRef.current;
    const { [filePath]: _previous, ...rest } = current;
    const updated =
      next === savedContent && !writing.current
        ? rest
        : { ...current, [filePath]: next };
    draftsRef.current = updated;
    setDrafts(updated);
  };

  // A file Work named Untitled asks for its name when it is first saved;
  // keeping that name saves it as it is from then on.
  const [naming, setNaming] = useState<"save" | "rename" | null>(null);
  useEffect(() => {
    if (renameRequest !== undefined) setNaming("rename");
  }, [renameRequest]);
  const keptNamesRef = useRef(new Set<string>());
  const personal = filePath ? PERSONAL_PREFIX_PATTERN.test(filePath) : false;

  const saveRef = useRef(() => {});
  saveRef.current = () => {
    if (!filePath) return;
    const content = draftsRef.current[filePath];
    if (writeFile.isPending) return;
    if (
      onRename &&
      personal &&
      UNTITLED_NAME.test(baseName(filePath)) &&
      !keptNamesRef.current.has(filePath)
    ) {
      setNaming("save");
      return;
    }
    if (content !== undefined) void persist(filePath).catch(() => undefined);
  };

  const persist = async (path: string) => {
    while (writing.current) await writing.current;
    const content = draftsRef.current[path];
    const baseline = queryClient.getQueryData<{ content: string }>([
      "desktop-editor-file",
      projectId,
      path,
    ]);
    if (content === undefined || !baseline) return;
    if (content === baseline.content) {
      const { [path]: _unchanged, ...rest } = draftsRef.current;
      draftsRef.current = rest;
      setDrafts(rest);
      return;
    }
    const pending = writeFile.mutateAsync({
      path,
      content,
      expectedContent: baseline.content,
    });
    writing.current = pending;
    try {
      await pending;
    } finally {
      if (writing.current === pending) writing.current = null;
    }
  };
  const persistRef = useRef(persist);
  persistRef.current = persist;

  // Autosave only edits: opening or normalizing Markdown never writes.
  // Explicit Save can still ask for an Untitled document's name.
  useEffect(() => {
    if (naming || writing.current || writeFile.isPending || writeFile.isError)
      return;
    const paths = Object.keys(drafts).filter(isMarkdownPath);
    if (!paths.length) return;
    const timer = setTimeout(() => {
      void (async () => {
        for (const path of paths) await persistRef.current(path);
      })().catch(() => undefined);
    }, 500);
    return () => clearTimeout(timer);
  }, [drafts, naming, writeFile.isPending, writeFile.isError]);

  // Leaving the pane flushes its debounce, without interrupting a save.
  useEffect(() => {
    if (!active && filePath && isMarkdownPath(filePath))
      void persistRef.current(filePath).catch(() => undefined);
  }, [active, filePath]);

  const flushMarkdown = async () => {
    while (Object.keys(draftsRef.current).some(isMarkdownPath))
      for (const path of Object.keys(draftsRef.current).filter(isMarkdownPath))
        await persistRef.current(path);
  };
  const flushMarkdownRef = useRef(flushMarkdown);
  flushMarkdownRef.current = flushMarkdown;
  useWorkspaceFlush({ save: flushMarkdown });
  useEffect(() => {
    onSaveBeforeClose?.(() => flushMarkdownRef.current());
    return () => onSaveBeforeClose?.(null);
  }, [onSaveBeforeClose]);

  const saveBeforeAction = async (action: (filePath: string) => void) => {
    if (!filePath) return;
    do {
      await persist(filePath);
    } while (draftsRef.current[filePath] !== undefined);
    action(filePath);
  };

  const renameTo = async (name: string) => {
    if (!filePath || !onRename) return;
    // Finish the draft before moving the file it belongs to.
    do {
      await persist(filePath);
    } while (draftsRef.current[filePath] !== undefined);
    const renamed = await desktopApi.editorFileRename({
      filePath: await localEditorPath(projectId, filePath),
      name,
    });
    const nextPath = filePath.replace(/[^/]*$/, baseName(renamed));
    if (nextPath === filePath) return;
    queryClient.setQueryData(
      ["desktop-editor-file", projectId, nextPath],
      queryClient.getQueryData(["desktop-editor-file", projectId, filePath]),
    );
    // An unsaved draft is the file's, whatever it is called.
    setDrafts((current) => {
      const { [filePath]: moved, ...rest } = current;
      return moved === undefined ? current : { ...rest, [nextPath]: moved };
    });
    onRename(nextPath);
  };

  // Selection channel: while this pane's editor has focus, chats can pull
  // "what's selected" to build a selection pill (see lib/editor-selection).
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;
  const screenRef = useRef<HTMLDivElement>(null);
  const unregisterRef = useRef<(() => void) | null>(null);
  const publishReader = (
    read: () => { text: string; startLine?: number; endLine?: number } | null,
  ) => {
    unregisterRef.current?.();
    unregisterRef.current = registerSelectionReader(() => {
      const path = filePathRef.current;
      // Tabs and inactive projects keep their editors mounted. Their old
      // selections are not context for a chat opened over another surface.
      // Read the workspace's known pane state before asking the browser:
      // checkVisibility can flush styles across every retained transcript.
      if (!path || !activeRef.current) return null;
      const selection = read();
      if (
        !selection ||
        !screenRef.current?.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
        })
      )
        return null;
      return { filePath: path, ...selection };
    });
  };
  useEffect(() => () => unregisterRef.current?.(), []);

  const handleMount: OnMount = (
    editor: EditorInstance,
    monaco: MonacoInstance,
  ) => {
    editorRef.current = editor;
    if (line) {
      editor.setPosition({ lineNumber: line, column: column ?? 1 });
      editor.revealLineInCenter(line);
    }
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      saveRef.current(),
    );
    const readMonacoSelection = () => {
      const selection = editor.getSelection();
      const model = editor.getModel();
      if (!selection || !model || selection.isEmpty()) return null;
      const text = model.getValueInRange(selection);
      if (!text.trim()) return null;
      return {
        text,
        startLine: selection.startLineNumber,
        endLine:
          selection.endColumn === 1 &&
          selection.endLineNumber > selection.startLineNumber
            ? selection.endLineNumber - 1
            : selection.endLineNumber,
      };
    };
    editor.onDidChangeCursorSelection(notifyEditorSelectionChange);
    editor.onDidFocusEditorText(() => publishReader(readMonacoSelection));
    if (canAutofocus()) moveFocusAsApp(() => editor.focus());
  };

  if (!filePath) {
    return (
      <div className="grid flex-1 place-items-center text-sm text-fg-muted">
        <button type="button" onClick={onFindFile} className="text-accent">
          Find a file in the palette
        </button>
      </div>
    );
  }

  return (
    // Copies out of either editor carry their file + line range, so pasting
    // into a chat makes a selection pill (see lib/editor-selection). React's
    // handler runs after Monaco's/ProseMirror's own copy populated the event.
    <div
      ref={screenRef}
      className="flex min-h-0 flex-1 flex-col"
      onCopy={stampSelectionOnClipboard}
    >
      <div
        data-editor-toolbar
        className="flex h-12 shrink-0 items-center gap-2 px-3"
      >
        <span className="min-w-0 truncate font-mono text-xs text-fg-muted">
          {filePath.replace(PERSONAL_PREFIX_PATTERN, "")}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-bg-raised p-0.5">
          {!isMarkdownPath(filePath) && (
            <FileInspector
              projectId={projectId}
              filePath={filePath}
              dirty={draft !== undefined}
              saving={writeFile.isPending}
              onSave={() => saveRef.current()}
              onRename={onRename ? () => setNaming("rename") : undefined}
              onPublish={onShare ? () => saveBeforeAction(onShare) : undefined}
              onPropose={
                onPropose ? () => saveBeforeAction(onPropose) : undefined
              }
              onSharePersonal={
                onSharePersonal
                  ? (intent) =>
                      saveBeforeAction((path) => onSharePersonal(path, intent))
                  : undefined
              }
            />
          )}
          {!officeFile && !pdfFile && savedContent !== undefined && (
            <FileSaveButton
              dirty={draft !== undefined}
              saving={writeFile.isPending}
              testId="editor-save"
              onSave={() => saveRef.current()}
            />
          )}
        </span>
      </div>
      <ActionInputDialog
        selectInitialValue
        requestKey={naming ?? undefined}
        request={
          naming && {
            label: naming === "save" ? "Save file" : "Rename file",
            input: {
              title: naming === "save" ? "Save file" : "Rename file",
              submit: naming === "save" ? "Save" : "Rename",
              fields: [
                {
                  name: "name",
                  label: "Name",
                  value:
                    naming === "save"
                      ? suggestedName(draft ?? savedContent)
                      : withoutExtension(baseName(filePath)),
                  placeholder: "File name",
                },
              ],
            },
            run: async (values) => {
              const name =
                typeof values.name === "string" ? values.name.trim() : "";
              if (!name) throw new Error("Name the file.");
              if (naming === "save") {
                await saveBeforeAction(() => undefined);
                keptNamesRef.current.add(filePath);
              }
              await renameTo(name);
            },
          }
        }
        onClose={() => setNaming(null)}
      />
      {(fileQuery.error || writeFile.error || pdfError) && (
        <p role="alert" className="p-3 text-xs text-danger">
          {fileQuery.error?.message ?? writeFile.error?.message ?? pdfError}
          {writeFile.isError && (
            <button
              type="button"
              data-testid="editor-reload"
              className="button-ghost button-sm ml-2"
              onClick={() => {
                const { [filePath]: _discarded, ...rest } = draftsRef.current;
                draftsRef.current = rest;
                setDrafts(rest);
                writeFile.reset();
                void fileQuery.refetch();
              }}
            >
              Discard edits and reload
            </button>
          )}
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        {pdfFile ? (
          pdfUrl ? (
            <iframe
              src={pdfUrl}
              title={filePath}
              className="size-full border-0 bg-bg"
            />
          ) : (
            <div className="grid flex-1 place-items-center text-sm text-fg-muted">
              Loading…
            </div>
          )
        ) : officeFile ? (
          <div className="grid flex-1 place-items-center p-8">
            <div className="max-w-sm text-center">
              <span className="mx-auto grid size-14 place-items-center rounded-2xl border border-border bg-bg-raised text-accent">
                <FileText className="size-6" />
              </span>
              <h2 className="mt-4 truncate text-sm font-semibold text-fg">
                {filePath.split("/").at(-1)}
              </h2>
              <p className="mt-1 text-xs leading-5 text-fg-muted">
                Open this document in its native app. Sharing stays available in
                the window's top bar.
              </p>
              <button
                type="button"
                onClick={() => {
                  void desktopApi
                    .projectOpenFile(projectId, filePath)
                    .catch(() => undefined);
                }}
                className="button-primary mt-4"
              >
                <ExternalLink className="size-3.5" />
                Open document
              </button>
            </div>
          </div>
        ) : savedContent !== undefined && isMarkdownPath(filePath) ? (
          <Suspense fallback={<div className="flex-1 bg-bg" />}>
            <MarkdownEditor
              key={filePath}
              value={draft ?? savedContent}
              onChange={handleChange}
              onSave={() => saveRef.current()}
              canAutofocus={canAutofocus}
              documentPath={filePath}
              readImage={(path) =>
                desktopApi.projectImage({ projectId, filePath: path })
              }
              onSelectionReader={(reader) => {
                if (reader) publishReader(reader);
                else {
                  unregisterRef.current?.();
                  unregisterRef.current = null;
                }
              }}
            />
          </Suspense>
        ) : savedContent !== undefined ? (
          <Editor
            height="100%"
            path={`catamorphic-editor://${encodeURIComponent(projectId)}/${encodeURIComponent(filePath)}`}
            theme={editorTheme}
            value={draft ?? savedContent}
            onChange={(value) => handleChange(value ?? "")}
            onMount={handleMount}
            options={{
              lineNumbers: "on",
              minimap: { enabled: false },
              fontSize: 13,
              fontFamily: theme?.fonts.mono,
              tabSize: 2,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              padding: { top: 12 },
              fixedOverflowWidgets: true,
            }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-sm text-fg-muted">
            <p>{fileQuery.isError ? fileQuery.error.message : "Loading…"}</p>
            {fileQuery.isError && (
              <button
                type="button"
                className="rounded border border-border px-3 py-1.5"
                onClick={() =>
                  void localEditorPath(projectId, filePath).then(
                    (absolutePath) => desktopApi.revealFolder(absolutePath),
                  )
                }
              >
                Open in default app
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
