"use client";

import type { WorkflowNode } from "@catamorphic/parser";
import type { CodeEditorRenderProps } from "@catamorphic/ui";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef } from "react";

const Editor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

const WORKFLOW_TYPE_DEFS = `
declare function sleep(duration: string): Promise<void>;

interface WorkflowContext {
  readonly workflowId: string;
  readonly runId: string;
}
`;

interface MinimalEditor {
  revealLineInCenter(line: number): void;
  setPosition(pos: { lineNumber: number; column: number }): void;
  setSelection(sel: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  }): void;
  focus(): void;
  onDidChangeCursorPosition(
    listener: (e: { position: { lineNumber: number; column: number } }) => void,
  ): { dispose(): void };
}

function findNodeAtPosition({
  line,
  column,
  nodes,
}: {
  line: number;
  column: number;
  nodes: WorkflowNode[];
}): WorkflowNode | null {
  const CONTAINER_TYPES = new Set([
    "if-block",
    "branch",
    "loop-block",
    "parallel-block",
    "scope-block",
  ]);
  let best: WorkflowNode | null = null;
  let bestSpan = Infinity;

  for (const node of nodes) {
    if (CONTAINER_TYPES.has(node.type)) continue;
    const { startLine, startColumn, endLine, endColumn } = node.sourceRange;
    const afterStart =
      line > startLine || (line === startLine && column >= startColumn);
    const beforeEnd =
      line < endLine || (line === endLine && column <= endColumn);
    if (afterStart && beforeEnd) {
      const span = node.sourceRange.end - node.sourceRange.start;
      if (span < bestSpan) {
        best = node;
        bestSpan = span;
      }
    }
  }
  return best;
}

export function MonacoCodeEditor({
  code,
  onChange,
  selectedNode,
  allNodes,
  onSelectNode,
}: CodeEditorRenderProps) {
  const editorRef = useRef<MinimalEditor | null>(null);
  const pendingNodeRef = useRef(selectedNode);
  const monacoConfigured = useRef(false);
  const programmaticReveal = useRef(false);
  pendingNodeRef.current = selectedNode;

  const handleBeforeMount = useCallback((monaco: Record<string, unknown>) => {
    if (monacoConfigured.current) return;
    monacoConfigured.current = true;

    const ts = (
      monaco as {
        languages: {
          typescript: {
            typescriptDefaults: {
              setCompilerOptions: (opts: Record<string, unknown>) => void;
              setDiagnosticsOptions: (opts: Record<string, unknown>) => void;
              addExtraLib: (content: string, filePath: string) => void;
            };
            ScriptTarget: Record<string, number>;
            ModuleKind: Record<string, number>;
            ModuleResolutionKind: Record<string, number>;
            JsxEmit: Record<string, number>;
          };
        };
      }
    ).languages.typescript;

    ts.typescriptDefaults.setCompilerOptions({
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      esModuleInterop: true,
      noEmit: true,
      jsx: ts.JsxEmit.None,
    });

    ts.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
    });

    ts.typescriptDefaults.addExtraLib(
      WORKFLOW_TYPE_DEFS,
      "workflow-globals.d.ts",
    );

    const editor = (
      monaco as {
        editor: {
          defineTheme: (name: string, theme: Record<string, unknown>) => void;
        };
      }
    ).editor;

    editor.defineTheme("catamorphic-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "6a737d", fontStyle: "italic" },
        { token: "keyword", foreground: "c792ea" },
        { token: "string", foreground: "a5d6ff" },
        { token: "number", foreground: "79c0ff" },
        { token: "type", foreground: "7ee787" },
        { token: "function", foreground: "d2a8ff" },
      ],
      colors: {
        "editor.background": "#0a0a0a",
        "editor.foreground": "#e5e5e5",
        "editor.lineHighlightBackground": "#1a1a1a",
        "editor.selectionBackground": "#264f78",
        "editorCursor.foreground": "#3b82f6",
        "editorLineNumber.foreground": "#404040",
        "editorLineNumber.activeForeground": "#737373",
        "editorIndentGuide.background": "#1a1a1a",
        "editorWidget.background": "#0f0f0f",
        "editorWidget.border": "#333333",
      },
    });
  }, []);

  const allNodesRef = useRef(allNodes);
  allNodesRef.current = allNodes;
  const onSelectNodeRef = useRef(onSelectNode);
  onSelectNodeRef.current = onSelectNode;
  const cursorDrivenRef = useRef(false);
  const lastCursorSelectedId = useRef<string | null>(null);

  const revealNode = useCallback((editor: MinimalEditor, node: typeof selectedNode) => {
    if (!node) return;
    programmaticReveal.current = true;
    const { startLine, startColumn, endLine, endColumn } = node.sourceRange;
    editor.revealLineInCenter(startLine);
    editor.setSelection({
      startLineNumber: startLine,
      startColumn,
      endLineNumber: endLine,
      endColumn,
    });
    editor.setPosition({ lineNumber: startLine, column: startColumn });
    editor.focus();
    requestAnimationFrame(() => {
      programmaticReveal.current = false;
    });
  }, []);

  const handleEditorMount = useCallback((editor: MinimalEditor) => {
    editorRef.current = editor;
    revealNode(editor, pendingNodeRef.current);

    editor.onDidChangeCursorPosition((e) => {
      if (programmaticReveal.current) return;
      const match = findNodeAtPosition({
        line: e.position.lineNumber,
        column: e.position.column,
        nodes: allNodesRef.current,
      });
      const matchId = match?.id ?? null;
      lastCursorSelectedId.current = matchId;
      cursorDrivenRef.current = true;
      onSelectNodeRef.current(matchId);
      requestAnimationFrame(() => {
        cursorDrivenRef.current = false;
      });
    });
  }, [revealNode]);

  useEffect(() => {
    if (cursorDrivenRef.current) return;
    if (selectedNode && editorRef.current) {
      revealNode(editorRef.current, selectedNode);
    }
  }, [selectedNode, revealNode]);

  return (
    <Editor
      height="100%"
      defaultLanguage="typescript"
      defaultPath="workflow.ts"
      theme="catamorphic-dark"
      value={code}
      onChange={(value: string | undefined) => onChange(value ?? "")}
      beforeMount={handleBeforeMount}
      onMount={handleEditorMount}
      loading={
        <div style={{ padding: 20, color: "#525252", fontSize: 13 }}>
          Loading editor...
        </div>
      }
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: '"Fira Code", "SF Mono", "JetBrains Mono", monospace',
        fontLigatures: true,
        lineNumbers: "on",
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        padding: { top: 16 },
        renderLineHighlight: "line",
        smoothScrolling: true,
        cursorBlinking: "smooth",
        cursorSmoothCaretAnimation: "on",
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: true, indentation: true },
        scrollbar: {
          verticalScrollbarSize: 8,
          horizontalScrollbarSize: 8,
        },
        overviewRulerBorder: false,
        hideCursorInOverviewRuler: true,
      }}
    />
  );
}
