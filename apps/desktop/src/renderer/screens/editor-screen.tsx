import Editor, { type OnMount } from "@monaco-editor/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLink, FileText } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { desktopApi } from "../lib/desktop-api.js";
import {
  registerSelectionReader,
  stampSelectionOnClipboard,
} from "../lib/editor-selection.js";
import { localEditorPath } from "../lib/local-project-files.js";
import { useMonacoTheme } from "../lib/monaco-setup.js";
import { useTheme } from "../lib/theme.js";

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
  line?: number;
  column?: number;
  navigation?: string;
  /** Path of the open file (project-relative), or null for a palette entry point. */
  filePath: string | null;
  onFindFile: () => void;
  /** Any unsaved draft in this tab — surfaces as a dot on the tab icon. */
  onDirtyChange: (dirty: boolean) => void;
  /** Register the surface-level Share action in the window's top bar. */
  registerShare?: (share: () => Promise<void>) => void;
  onShare?: (filePath: string) => void;
}

export function EditorScreen({
  projectId,
  line,
  column,
  navigation,
  filePath,
  onFindFile,
  onDirtyChange,
  registerShare,
  onShare,
}: EditorScreenProps) {
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
  });
  const writeFile = useMutation({
    mutationFn: async ({ path, content }: { path: string; content: string }) =>
      desktopApi.editorFileWrite({
        filePath: await localEditorPath(projectId, path),
        content,
        expectedContent: fileQuery.data?.content ?? "",
      }),
    onSuccess: () => {
      void fileQuery.refetch();
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
  useEffect(() => {
    if (!pdfFile || !filePath) {
      setPdfUrl(null);
      return;
    }
    let cancelled = false;
    void desktopApi.projectRoot(projectId).then((root) => {
      if (cancelled || !root) return;
      const url = new URL("file:///");
      url.pathname = `${root.replace(/\/$/, "")}/${filePath}`;
      setPdfUrl(url.href);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath, pdfFile, projectId]);

  // Unsaved edits, kept per path so switching files within the tab never
  // drops work. A draft equal to the saved content is removed.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

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
    setDrafts((current) => {
      if (next === savedContent) {
        const { [filePath]: _dropped, ...rest } = current;
        return rest;
      }
      return { ...current, [filePath]: next };
    });
  };

  const saveRef = useRef(() => {});
  saveRef.current = () => {
    if (!filePath) return;
    const content = draftsRef.current[filePath];
    if (content === undefined || writeFile.isPending) return;
    writeFile.mutate(
      { path: filePath, content },
      {
        onSuccess: () => {
          setDrafts((current) => {
            if (current[filePath] !== content) return current;
            const { [filePath]: _saved, ...rest } = current;
            return rest;
          });
        },
      },
    );
  };

  const shareRef = useRef(async () => {});
  shareRef.current = async () => {
    if (!filePath || writeFile.isPending) return;
    const content = draftsRef.current[filePath];
    if (content !== undefined) {
      await writeFile.mutateAsync({ path: filePath, content });
      setDrafts((current) => {
        if (current[filePath] !== content) return current;
        const { [filePath]: _saved, ...rest } = current;
        return rest;
      });
    }
    onShare?.(filePath);
  };
  useEffect(() => {
    registerShare?.(() => shareRef.current());
  }, [registerShare]);

  // Selection channel: while this pane's editor has focus, chats can pull
  // "what's selected" to build a selection pill (see lib/editor-selection).
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;
  const unregisterRef = useRef<(() => void) | null>(null);
  const publishReader = (
    read: () => { text: string; startLine?: number; endLine?: number } | null,
  ) => {
    unregisterRef.current?.();
    unregisterRef.current = registerSelectionReader(() => {
      const path = filePathRef.current;
      if (!path) return null;
      const selection = read();
      return selection ? { filePath: path, ...selection } : null;
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
    editor.onDidFocusEditorText(() => publishReader(readMonacoSelection));
    publishReader(readMonacoSelection);
    editor.focus();
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
      className="flex min-h-0 flex-1 flex-col"
      onCopy={stampSelectionOnClipboard}
    >
      <div
        data-editor-toolbar
        className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-bg-inset px-3"
      >
        <span className="min-w-0 truncate font-mono text-xs text-fg-muted">
          {filePath}
        </span>
        <span
          className="ml-auto text-xs text-fg-faint"
          title="Saving updates this file on your device. Uploading and recording a Git commit are separate actions."
        >
          On this device
        </span>
        {draft !== undefined && (
          <button
            type="button"
            data-testid="editor-save"
            onClick={() => saveRef.current()}
            disabled={writeFile.isPending}
            data-disabled-reason="Saving this file"
            className="ml-auto h-6 shrink-0 cursor-pointer rounded border border-border-strong bg-bg-overlay px-2 text-xs text-fg transition-colors duration-150 hover:border-accent disabled:opacity-50"
          >
            {writeFile.isPending ? "Saving…" : "Save"}
          </button>
        )}
      </div>
      {(fileQuery.error || writeFile.error) && (
        <p role="alert" className="p-3 text-xs text-danger">
          {fileQuery.error?.message ?? writeFile.error?.message}
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
                className="mt-4 inline-flex h-8 cursor-pointer items-center gap-2 rounded-md bg-accent px-3 text-xs font-medium text-accent-fg hover:opacity-90"
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
