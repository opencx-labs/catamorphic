"use client";

import {
  findWorkflowDefinitions,
  type WorkflowDefinition,
} from "@catamorphic/react";
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
  updateOptions(options: Record<string, unknown>): void;
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

function getLanguage({ path }: { path: string }): string {
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx")) return "javascript";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".css")) return "css";
  return "plaintext";
}

function isSourceFile({ path }: { path: string }): boolean {
  return (
    path.endsWith(".ts") ||
    path.endsWith(".tsx") ||
    path.endsWith(".js") ||
    path.endsWith(".jsx")
  );
}

function basename({ path }: { path: string }): string {
  return path.split("/").pop() ?? path;
}

export interface MultiTabMonacoProps {
  openTabs: string[];
  activeTab: string | null;
  files: Record<string, string>;
  modifiedFiles: ReadonlySet<string>;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onChange: (params: { path: string; content: string }) => void;
  readOnly?: boolean;
  /**
   * Fired when the user clicks the gutter "Run" glyph next to a workflow
   * definition in the currently-active tab.
   */
  onRunWorkflow?: (params: { name: string }) => void;
}

export function MultiTabMonaco({
  openTabs,
  activeTab,
  files,
  modifiedFiles,
  onSelectTab,
  onCloseTab,
  onChange,
  readOnly = false,
  onRunWorkflow,
}: MultiTabMonacoProps) {
  const monacoConfigured = useRef(false);
  const monacoRef = useRef<MonacoNamespace | null>(null);
  const editorRef = useRef<MinimalEditor | null>(null);
  const decorationIdsRef = useRef<string[]>([]);
  const definitionsByLineRef = useRef<Map<number, WorkflowDefinition>>(
    new Map(),
  );
  const onRunWorkflowRef = useRef(onRunWorkflow);
  onRunWorkflowRef.current = onRunWorkflow;

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

  const activeContent = activeTab ? (files[activeTab] ?? "") : "";

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
    if (!activeTab || !isSourceFile({ path: activeTab })) {
      definitionsByLineRef.current = new Map();
      renderDecorations();
      return;
    }

    const defs = findWorkflowDefinitions({ source: activeContent });
    const map = new Map<number, WorkflowDefinition>();
    for (const def of defs) map.set(def.line, def);
    definitionsByLineRef.current = map;
    renderDecorations();
  }, [activeTab, activeContent, renderDecorations]);

  const handleGlyphClick = useCallback((line: number) => {
    const def = definitionsByLineRef.current.get(line);
    if (!def) return;
    onRunWorkflowRef.current?.({ name: def.name });
  }, []);

  const handleEditorMount = useCallback(
    (editor: MinimalEditor) => {
      editorRef.current = editor;
      editor.updateOptions({ glyphMargin: true });
      renderDecorations();

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
    [renderDecorations, handleGlyphClick],
  );

  return (
    <div className="flex flex-col h-full bg-neutral-950">
      <div className="flex border-b border-neutral-800 overflow-x-auto shrink-0">
        {openTabs.map((tab) => {
          const isActive = tab === activeTab;
          const isModified = modifiedFiles.has(tab);
          return (
            <div
              key={tab}
              className={`group flex items-center gap-1.5 px-3 py-1.5 text-xs border-r border-neutral-800 cursor-pointer select-none shrink-0 ${
                isActive
                  ? "bg-neutral-900 text-neutral-200 border-b-2 border-b-blue-500"
                  : "text-neutral-500 hover:text-neutral-300 hover:bg-neutral-900/50"
              }`}
              onClick={() => onSelectTab(tab)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSelectTab(tab);
              }}
              role="tab"
              tabIndex={0}
              aria-selected={isActive}
            >
              {isModified && (
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
              )}
              <span className="truncate max-w-[120px]">
                {basename({ path: tab })}
              </span>
              <button
                type="button"
                className="ml-1 opacity-0 group-hover:opacity-100 hover:text-neutral-100 transition-opacity"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab);
                }}
                aria-label={`Close ${basename({ path: tab })}`}
              >
                &times;
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex-1 min-h-0">
        {activeTab ? (
          <Editor
            key={activeTab}
            height="100%"
            language={getLanguage({ path: activeTab })}
            path={activeTab}
            theme="catamorphic-dark"
            value={activeContent}
            onChange={(value: string | undefined) => {
              if (activeTab) {
                onChange({ path: activeTab, content: value ?? "" });
              }
            }}
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
        ) : (
          <div className="flex items-center justify-center h-full text-neutral-600 text-sm">
            Select a file to edit
          </div>
        )}
      </div>
    </div>
  );
}
