"use client";

import { useCodeEditorLink } from "@catamorphic/react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { useEffect, useRef } from "react";

type EditorInstance = Parameters<OnMount>[0];
type MonacoInstance = Parameters<OnMount>[1];

const WORKFLOW_AUTHORING_TYPES = `
declare module "@catamorphic/workflow" {
  export type JsonValue = boolean | number | string | null | { readonly [key: string]: JsonValue } | readonly JsonValue[];
  export interface RetryPolicy { maxAttempts: number; backoff?: { initial: string; maximum?: string; multiplier?: number }; }
  declare const transitionBrand: unique symbol;
  export interface WorkflowTransition<Output> { readonly [transitionBrand]: Output; }
  export type PauseResult<Value, State = never> =
    | ({ reason: "resumed"; value: Value } & ([State] extends [never] ? object : { state: State }))
    | ({ reason: "timed_out" } & ([State] extends [never] ? object : { state: State }));
  export interface Pause {
    <Value>(): WorkflowTransition<Extract<PauseResult<Value>, { reason: "resumed" }>>;
    <Value>(options: { timeout: string }): WorkflowTransition<PauseResult<Value>>;
    <Value, State>(options: { timeout?: string; state: State }): WorkflowTransition<PauseResult<Value, State>>;
  }
  export interface WorkflowDefinition<Input, Output> { readonly steps: readonly (BoundaryDefinition<unknown, unknown> | BatchDefinition<unknown, unknown>)[]; }
  export type CallWorkflow = <Input, Output>(workflow: WorkflowDefinition<Input, Output>, options: { input: Input }) => WorkflowTransition<Output>;
  export interface BoundaryContext<Input> { readonly input: Input; readonly pause: Pause; readonly callWorkflow: CallWorkflow; }
  export interface BoundaryDefinition<Input, Output> { readonly run: (context: BoundaryContext<Input>) => unknown | Promise<unknown>; readonly retry?: RetryPolicy; }
  export interface BatchExecutionContext { invocationId: string; attempt: number; deadlineAt: string; signal: AbortSignal; }
  export interface BatchDefinition<Input, Output> { readonly source: (args: { input: Input; context: BatchExecutionContext }) => unknown; readonly process: (args: { key: string; item: unknown; context: BatchExecutionContext }) => Promise<unknown>; }
  export interface DefineBatch {
    <Input, Result>(options: {
      source(args: { input: Input; context: BatchExecutionContext }): unknown;
      process(args: { key: string; item: unknown; context: BatchExecutionContext }): Promise<Result>;
      failurePolicy?: { mode: "continue" | "fail_fast"; maxFailures?: number };
      sink?: unknown;
    }): BatchDefinition<Input, { summary: { total: number; succeeded: number; failed: number; skipped: number }; artifact?: unknown }>;
  }
  export interface WorkflowBuilderContext {
    readonly defineBoundary: <Input, Returned>(options: {
      retry?: RetryPolicy;
      run(context: BoundaryContext<Input>): Returned | Promise<Returned>;
    }) => BoundaryDefinition<Input, Awaited<Returned> extends WorkflowTransition<infer Output> ? Output : Awaited<Returned>>;
    readonly defineBatch: DefineBatch;
  }
  export function defineWorkflow<Steps extends readonly [BoundaryDefinition<unknown, unknown> | BatchDefinition<unknown, unknown>, ...(BoundaryDefinition<unknown, unknown> | BatchDefinition<unknown, unknown>)[]]>(
    build: (context: WorkflowBuilderContext) => { readonly steps: Steps; readonly controls?: { readonly cancel?: true } },
  ): WorkflowDefinition<unknown, unknown>;
  export interface BatchStepPolicy { maxItems: number; maxWaitMs: number; maxBytes?: number; }
  export interface BatchStepDefinition<Item, Result> { (input: Item): Promise<Result>; readonly batch: BatchStepPolicy; }
  export function defineBatchStep<Item, Result>(definition: {
    batch: BatchStepPolicy;
    partitionBy?: (input: Item) => JsonValue;
    run(args: { items: readonly { key: string; value: Item }[]; context: BatchExecutionContext }): Promise<readonly ({ key: string; status: "succeeded"; result: Result } | { key: string; status: "failed"; error: { message: string } } | { key: string; status: "skipped"; reason?: string })[]>;
  }): BatchStepDefinition<Item, Result>;
}
`;

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
    monaco.languages.typescript.typescriptDefaults.addExtraLib(
      WORKFLOW_AUTHORING_TYPES,
      "file:///node_modules/@catamorphic/workflow/index.d.ts",
    );

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
