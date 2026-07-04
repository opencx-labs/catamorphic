"use client";

import { useCodeEditorLink } from "@catamorphic/react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { useEffect, useRef } from "react";

type EditorInstance = Parameters<OnMount>[0];
type MonacoInstance = Parameters<OnMount>[1];

export interface MonacoCodeEditorProps {
  code: string;
  onChange: (code: string) => void;
  readOnly?: boolean;
  /** Model path; affects how the TS service treats the file. */
  path?: string;
  theme?: string;
}

function applyReveal({
  editor,
  monaco,
  range,
  programmaticReveal,
}: {
  editor: EditorInstance;
  monaco: MonacoInstance;
  range: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
  programmaticReveal: { current: boolean };
}) {
  programmaticReveal.current = true;
  try {
    editor.revealLineInCenter(range.startLine);
    // Anchor at the end, position at the start: selects the whole node
    // range while leaving the cursor on its first character.
    editor.setSelection(
      new monaco.Selection(
        range.endLine,
        range.endColumn,
        range.startLine,
        range.startColumn,
      ),
    );
    editor.focus();
  } finally {
    programmaticReveal.current = false;
  }
}

/**
 * TypeScript Monaco editor for the workflow detail panel's Code tab.
 * Syntax highlighting, TS diagnostics/hover/completion, line numbers, and
 * bidirectional code ↔ canvas linking via `useCodeEditorLink`:
 * selecting a canvas node scrolls to and highlights its source; moving the
 * cursor selects the node under it on the canvas.
 *
 * Mount inside `WorkflowEditor` / `WorkflowEditorScope`:
 *
 * ```tsx
 * <WorkflowEditor
 *   renderCodeEditor={({ code, onChange, readOnly }) => (
 *     <MonacoCodeEditor code={code} onChange={onChange} readOnly={readOnly} />
 *   )}
 * />
 * ```
 */
export function MonacoCodeEditor({
  code,
  onChange,
  readOnly = false,
  path = "file:///workflow.ts",
  theme = "vs-dark",
}: MonacoCodeEditorProps) {
  const { reveal, handleCursorPositionChange } = useCodeEditorLink();

  const editorRef = useRef<EditorInstance | null>(null);
  const monacoRef = useRef<MonacoInstance | null>(null);
  const programmaticReveal = useRef(false);
  const pendingReveal = useRef(reveal);

  useEffect(() => {
    pendingReveal.current = reveal;
    if (!reveal || !editorRef.current || !monacoRef.current) return;
    applyReveal({
      editor: editorRef.current,
      monaco: monacoRef.current,
      range: reveal.range,
      programmaticReveal,
    });
  }, [reveal]);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ESNext,
      module: monaco.languages.typescript.ModuleKind.ESNext,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      allowNonTsExtensions: true,
      strict: true,
    });
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      // 2307 "Cannot find module": only the active workflow file is loaded
      // into the editor, so cross-file and npm imports can't resolve here.
      diagnosticCodesToIgnore: [2307],
    });

    editor.onDidChangeCursorPosition((event) => {
      if (programmaticReveal.current) return;
      handleCursorPositionChange({
        line: event.position.lineNumber,
        column: event.position.column,
      });
    });

    // A node may already be selected when the Code tab (and thus the
    // editor) first mounts — apply that reveal now.
    if (pendingReveal.current) {
      applyReveal({
        editor,
        monaco,
        range: pendingReveal.current.range,
        programmaticReveal,
      });
    }
  };

  return (
    <Editor
      height="100%"
      path={path}
      defaultLanguage="typescript"
      theme={theme}
      value={code}
      onChange={(value) => onChange(value ?? "")}
      onMount={handleMount}
      options={{
        readOnly,
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
  );
}
