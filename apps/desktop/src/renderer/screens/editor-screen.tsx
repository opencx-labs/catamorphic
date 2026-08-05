import { useProjectFile, useProjectFiles, useWriteProjectFile } from "@catamorphic/react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { FileCode, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { commandScore } from "../lib/command-score.js";
import { ShortcutHint } from "../components/shortcut-hint.js";
import { useTheme } from "../lib/theme.js";

type EditorInstance = Parameters<OnMount>[0];
type MonacoInstance = Parameters<OnMount>[1];

/**
 * A code editor tab: quick-open over the project's files, Monaco on the
 * picked file (language inferred from the extension), Cmd+S / Save writes
 * through the embedded server's file API. One tab edits one file at a
 * time, but unsaved drafts survive switching files within the tab.
 */

export interface EditorScreenProps {
  projectId: string;
  /** Path of the open file (project-relative), or null → the picker. */
  filePath: string | null;
  onFileChange: (filePath: string | null) => void;
  /** Any unsaved draft in this tab — surfaces as a dot on the tab icon. */
  onDirtyChange: (dirty: boolean) => void;
}

export function EditorScreen({
  projectId,
  filePath,
  onFileChange,
  onDirtyChange,
}: EditorScreenProps) {
  const theme = useTheme();
  const fileQuery = useProjectFile(projectId, filePath ?? undefined);
  const writeFile = useWriteProjectFile(projectId);

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
        onSuccess: () =>
          setDrafts(({ [filePath]: _saved, ...rest }) => rest),
      },
    );
  };

  const handleMount: OnMount = (editor: EditorInstance, monaco: MonacoInstance) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      saveRef.current(),
    );
    editor.focus();
  };

  if (!filePath) {
    return (
      <FilePicker
        projectId={projectId}
        onPick={(path) => onFileChange(path)}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-bg-inset px-3">
        <ShortcutHint label="Open another file">
          <button
            type="button"
            onClick={() => onFileChange(null)}
            className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-xs text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
          >
            <Search className="size-3 shrink-0" />
            <span className="truncate">{filePath}</span>
          </button>
        </ShortcutHint>
        {draft !== undefined && (
          <button
            type="button"
            onClick={() => saveRef.current()}
            disabled={writeFile.isPending}
            className="ml-auto h-6 shrink-0 cursor-pointer rounded border border-border-strong bg-bg-overlay px-2 text-xs text-fg transition-colors duration-150 hover:border-accent disabled:opacity-50"
          >
            {writeFile.isPending ? "Saving…" : "Save"}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {savedContent !== undefined ? (
          <Editor
            height="100%"
            path={`file:///${filePath}`}
            theme={theme?.appearance === "light" ? "light" : "vs-dark"}
            value={draft ?? savedContent}
            onChange={(value) => handleChange(value ?? "")}
            onMount={handleMount}
            options={{
              lineNumbers: "on",
              minimap: { enabled: false },
              fontSize: 13,
              tabSize: 2,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              padding: { top: 12 },
              fixedOverflowWidgets: true,
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-fg-muted">
            {fileQuery.isError
              ? `Couldn't open ${filePath}`
              : "Loading…"}
          </div>
        )}
      </div>
    </div>
  );
}

/** Palette-style quick-open over the project's file list. */
function FilePicker({
  projectId,
  onPick,
}: {
  projectId: string;
  onPick: (path: string) => void;
}) {
  const filesQuery = useProjectFiles(projectId);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const files = filesQuery.data ?? [];
  const matches = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return files.slice(0, 100);
    return files
      .map((file) => ({
        file,
        score: commandScore(file.path, trimmed, []),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 100)
      .map((entry) => entry.file);
  }, [files, query]);

  const clampedHighlight = Math.min(highlighted, matches.length - 1);

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pt-[18vh]">
      <div className="w-full max-w-xl">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-inset px-3">
          <Search className="size-4 shrink-0 text-fg-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlighted(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setHighlighted((value) =>
                  Math.min(value + 1, matches.length - 1),
                );
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setHighlighted((value) => Math.max(value - 1, 0));
              } else if (event.key === "Enter") {
                const picked = matches[clampedHighlight];
                if (picked) onPick(picked.path);
              }
            }}
            placeholder="Open a file…"
            className="h-10 w-full bg-transparent text-sm text-fg outline-none placeholder:text-fg-faint"
          />
        </div>
        <ul className="mt-2 pb-8">
          {matches.map((file, index) => (
            <li key={file.path}>
              <button
                type="button"
                onClick={() => onPick(file.path)}
                onMouseEnter={() => setHighlighted(index)}
                className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-xs transition-colors duration-150 ${
                  index === clampedHighlight
                    ? "bg-bg-overlay text-fg"
                    : "text-fg-muted"
                }`}
              >
                <FileCode className="size-3.5 shrink-0 text-fg-faint" />
                <span className="truncate">{file.path}</span>
              </button>
            </li>
          ))}
          {!filesQuery.isLoading && matches.length === 0 && (
            <li className="px-2 py-6 text-center text-sm text-fg-muted">
              No files match “{query}”.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
