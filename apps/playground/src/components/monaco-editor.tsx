"use client";

import type { WorkflowNode } from "@catamorphic/parser";
import {
  findWorkflowDefinitions,
  type WorkflowDefinition,
} from "@catamorphic/react";
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
  updateOptions(options: Record<string, unknown>): void;
  onDidChangeCursorPosition(
    listener: (e: { position: { lineNumber: number; column: number } }) => void,
  ): { dispose(): void };
  onMouseDown(
    listener: (e: {
      target: {
        type: number;
        position: { lineNumber: number; column: number } | null;
      };
    }) => void,
  ): { dispose(): void };
  deltaDecorations(
    oldIds: string[],
    newDecorations: Array<{
      range: {
        startLineNumber: number;
        startColumn: number;
        endLineNumber: number;
        endColumn: number;
      };
      options: {
        glyphMarginClassName?: string;
        glyphMarginHoverMessage?: { value: string };
        stickiness?: number;
      };
    }>,
  ): string[];
}

interface MonacoNamespace {
  editor: {
    MouseTargetType: { GUTTER_GLYPH_MARGIN: number };
  };
  Range: new (
    startLine: number,
    startColumn: number,
    endLine: number,
    endColumn: number,
  ) => {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
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

export interface MonacoCodeEditorProps extends CodeEditorRenderProps {
  /**
   * Fired when the user clicks the gutter "Run" glyph next to a workflow
   * definition. The host decides how to respond (typically: open the Run
   * dialog for `name`, or navigate to that workflow's page).
   */
  onRunWorkflow?: (params: { name: string }) => void;
  /**
   * Fired when the caret enters a different workflow definition in the
   * editor. The host typically uses this to switch which workflow is shown
   * in the graph / breadcrumbs.
   */
  onActiveWorkflowChange?: (params: { name: string }) => void;
}

function findActiveWorkflowName({
  cursorLine,
  definitions,
}: {
  cursorLine: number;
  definitions: WorkflowDefinition[];
}): string | null {
  // Definitions are in source order. The active workflow is the one whose
  // `function` line is the greatest not exceeding the cursor.
  let active: WorkflowDefinition | null = null;
  for (const def of definitions) {
    if (def.line <= cursorLine) active = def;
    else break;
  }
  return active?.name ?? null;
}

export function MonacoCodeEditor({
  code,
  onChange,
  selectedNode,
  allNodes,
  onSelectNode,
  readOnly,
  onRunWorkflow,
  onActiveWorkflowChange,
}: MonacoCodeEditorProps) {
  const editorRef = useRef<MinimalEditor | null>(null);
  const monacoRef = useRef<MonacoNamespace | null>(null);
  const pendingNodeRef = useRef(selectedNode);
  const monacoConfigured = useRef(false);
  const programmaticReveal = useRef(false);
  pendingNodeRef.current = selectedNode;

  const decorationIdsRef = useRef<string[]>([]);
  const definitionsByLineRef = useRef<Map<number, WorkflowDefinition>>(
    new Map(),
  );
  const sortedDefinitionsRef = useRef<WorkflowDefinition[]>([]);
  const onRunWorkflowRef = useRef(onRunWorkflow);
  onRunWorkflowRef.current = onRunWorkflow;
  const onActiveWorkflowChangeRef = useRef(onActiveWorkflowChange);
  onActiveWorkflowChangeRef.current = onActiveWorkflowChange;
  const lastActiveWorkflowRef = useRef<string | null>(null);

  const handleBeforeMount = useCallback((monaco: Record<string, unknown>) => {
    monacoRef.current = monaco as unknown as MonacoNamespace;
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
  const lastRevealedNodeIdRef = useRef<string | null>(null);

  const revealNode = useCallback(
    (editor: MinimalEditor, node: typeof selectedNode) => {
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
    },
    [],
  );

  const renderDecorations = useCallback(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    const newDecorations = [...definitionsByLineRef.current.values()].map(
      (def) => ({
        range: new monaco.Range(def.line, 1, def.line, 1),
        options: {
          glyphMarginClassName: "catamorphic-run-glyph",
          glyphMarginHoverMessage: {
            value: `Run workflow \`${def.name}\``,
          },
          stickiness: 1,
        },
      }),
    );

    decorationIdsRef.current = editor.deltaDecorations(
      decorationIdsRef.current,
      newDecorations,
    );
  }, []);

  useEffect(() => {
    const defs = findWorkflowDefinitions({ source: code });
    const map = new Map<number, WorkflowDefinition>();
    for (const def of defs) map.set(def.line, def);
    definitionsByLineRef.current = map;
    sortedDefinitionsRef.current = [...defs].sort((a, b) => a.line - b.line);
    renderDecorations();
  }, [code, renderDecorations]);

  const handleGlyphClick = useCallback((line: number) => {
    const def = definitionsByLineRef.current.get(line);
    if (!def) return;
    onRunWorkflowRef.current?.({ name: def.name });
  }, []);

  const handleEditorMount = useCallback(
    (editor: MinimalEditor) => {
      editorRef.current = editor;
      // Fast Refresh keeps the existing Monaco instance alive even when the
      // options prop changes, so explicitly ensure the glyph margin is on.
      editor.updateOptions({ glyphMargin: true });
      const pending = pendingNodeRef.current;
      lastRevealedNodeIdRef.current = pending?.id ?? null;
      revealNode(editor, pending);
      renderDecorations();

      editor.onDidChangeCursorPosition((e) => {
        if (programmaticReveal.current) return;

        const activeName = findActiveWorkflowName({
          cursorLine: e.position.lineNumber,
          definitions: sortedDefinitionsRef.current,
        });
        if (activeName && activeName !== lastActiveWorkflowRef.current) {
          lastActiveWorkflowRef.current = activeName;
          onActiveWorkflowChangeRef.current?.({ name: activeName });
        }

        const match = findNodeAtPosition({
          line: e.position.lineNumber,
          column: e.position.column,
          nodes: allNodesRef.current,
        });
        const matchId = match?.id ?? null;
        // Record the cursor-driven selection so the downstream effect does not
        // treat it as an external selection change and reset the cursor.
        lastRevealedNodeIdRef.current = matchId;
        onSelectNodeRef.current(matchId);
      });

      editor.onMouseDown((e) => {
        const monaco = monacoRef.current;
        if (!monaco) return;
        if (
          e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN
        ) {
          return;
        }
        const line = e.target.position?.lineNumber;
        if (!line) return;
        if (!definitionsByLineRef.current.has(line)) return;
        handleGlyphClick(line);
      });
    },
    [revealNode, renderDecorations, handleGlyphClick],
  );

  // Only re-reveal when the selected node id changes (e.g. user clicked a
  // canvas node). Typing in the editor causes the graph to re-parse, producing
  // a new WorkflowNode object for the same selection — comparing by id prevents
  // the cursor from being reset on every keystroke.
  useEffect(() => {
    const currentId = selectedNode?.id ?? null;
    if (currentId === lastRevealedNodeIdRef.current) return;
    lastRevealedNodeIdRef.current = currentId;
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
        readOnly,
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: '"Fira Code", "SF Mono", "JetBrains Mono", monospace',
        fontLigatures: true,
        lineNumbers: "on",
        glyphMargin: true,
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
