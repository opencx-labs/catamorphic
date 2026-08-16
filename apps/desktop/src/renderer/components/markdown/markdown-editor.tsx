import { Editor } from "@tiptap/core";
import type { DragHandleRule } from "@tiptap/extension-drag-handle";
import DragHandle from "@tiptap/extension-drag-handle";
import BubbleMenu from "@tiptap/extension-bubble-menu";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { TableKit } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { DOMSerializer } from "@tiptap/pm/model";
import { joinFrontmatter, splitFrontmatter } from "./frontmatter.js";
import { MarkdownGuardrails } from "./guardrails.js";
import { lowlight } from "./lowlight.js";
import { MarkdownBubbleMenu } from "./bubble-menu.js";
import {
  installBlockEntrances,
  installDropFlip,
  installHandleMotion,
} from "./motion.js";
import { installRowDrag } from "./row-drag.js";
import "./markdown-editor.css";

/**
 * Rich markdown editor (Tiptap/ProseMirror). Markdown in, markdown out — the
 * document model round-trips through @tiptap/markdown, so files agents write
 * with plain tools open here and vice versa. Everything visual flows from the
 * design tokens; see DESIGN.md ("Markdown editing").
 */

export interface MarkdownEditorProps {
  /** Current markdown source (saved content or the tab's draft). */
  value: string;
  onChange: (markdown: string) => void;
  /** Cmd+S inside the editor. */
  onSave?: () => void;
  /**
   * Called with a reader for the current selection while this editor is
   * the one the user is working in (registered on focus, released on
   * blur/unmount). Chats pull it to build a selection pill.
   */
  onSelectionReader?: (
    reader: (() => EditorSelectionSnapshot | null) | null,
  ) => void;
}

export interface EditorSelectionSnapshot {
  /** The selected content, serialized back to markdown. */
  text: string;
  /** 1-based inclusive line range within the emitted markdown, if found. */
  startLine?: number;
  endLine?: number;
}

/**
 * Drag targets: top-level blocks (whole sections) and direct list items —
 * nothing else. Rows/cells inside tables never match, so tables drag whole.
 * (allowedContainers can't express this: it walks all ancestors, and doc is
 * an ancestor of everything.)
 */
const DRAG_SCOPE_RULE: DragHandleRule = {
  id: "cat-sections-and-list-items",
  evaluate: (context) =>
    context.parent &&
    (context.parent.type.name === "doc" ||
      ["bulletList", "orderedList", "taskList"].includes(
        context.parent.type.name,
      ))
      ? 0
      : Number.MAX_SAFE_INTEGER,
};

/** Markdown equality modulo trailing blank lines. */
const canonical = (markdown: string) => markdown.replace(/\s+$/, "");

const GRIP_DOTS_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>';

export function MarkdownEditor({
  value,
  onChange,
  onSave,
  onSelectionReader,
}: MarkdownEditorProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const gripRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const tintRef = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Editor | null>(null);

  // Parent callbacks live in refs so the editor never needs recreating.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onSelectionReaderRef = useRef(onSelectionReader);
  onSelectionReaderRef.current = onSelectionReader;
  // The markdown we last emitted; external `value` changes that differ from
  // it are real (file switch, reload) and reset the document.
  const lastEmittedRef = useRef<string | null>(null);
  // The doc's canonical serialization differs textually from the file
  // (table padding, list markers), so opening a file must not read as an
  // edit: while the doc still serializes to its initial form, emit the
  // ORIGINAL body — the host's draft comparison then sees "unchanged".
  const baselineRef = useRef<{
    fullText: string;
    bodyText: string;
    serialized: string;
  } | null>(null);
  // Frontmatter never enters the tiptap document (see frontmatter.ts); it
  // rides alongside and is re-joined into every emitted markdown string.
  const frontmatterRef = useRef<string | null>(null);
  const [frontmatter, setFrontmatterState] = useState<string | null>(null);
  const [frontmatterOpen, setFrontmatterOpen] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    const bubble = bubbleRef.current;
    if (!mount || !bubble) return;

    const initial = splitFrontmatter(value);
    frontmatterRef.current = initial.frontmatter;
    setFrontmatterState(initial.frontmatter);

    const handleHolder: { el: HTMLElement | null } = { el: null };
    const instance = new Editor({
      element: mount,
      extensions: [
        StarterKit.configure({
          codeBlock: false,
          dropcursor: { color: "var(--color-accent)", width: 2 },
        }),
        Markdown,
        TaskList,
        TaskItem.configure({ nested: true }),
        TableKit,
        CodeBlockLowlight.configure({
          lowlight,
          defaultLanguage: "plaintext",
        }),
        BubbleMenu.configure({
          element: bubble,
          options: { placement: "top", offset: 8 },
        }),
        DragHandle.configure({
          nested: { rules: [DRAG_SCOPE_RULE], edgeDetection: "none" },
          render: () => {
            const el = document.createElement("div");
            el.className = "cat-mdedit-handle";
            el.innerHTML = GRIP_DOTS_SVG;
            handleHolder.el = el;
            return el;
          },
          // listItem = bullet/number markers to clear; taskItem has none.
          onNodeChange: ({ node }) => {
            handleHolder.el?.classList.toggle(
              "for-list-item",
              node?.type.name === "listItem",
            );
          },
        }),
        MarkdownGuardrails,
      ],
      content: initial.body,
      contentType: "markdown",
      editorProps: {
        // Spellcheck squiggles popping in across the doc on first focus read
        // as a visual jump; the app owns spellcheck, not Chromium.
        attributes: { spellcheck: "false" },
        // Content never initiates a drag (paired with -webkit-user-drag CSS):
        // dragging over a selection starts a new selection instead of moving
        // it. The handle lives outside the editor DOM, so its dragstart never
        // reaches this handler.
        handleDOMEvents: {
          dragstart: (_view, event) => {
            event.preventDefault();
            return true;
          },
        },
      },
      onUpdate: ({ editor: current }) => {
        const baseline = baselineRef.current;
        // Transactions dispatched during construction (e.g. table fixing)
        // land before the baseline exists — initialization, not edits.
        if (!baseline) return;
        const serialized = current.getMarkdown();
        // Trailing-blank differences aren't edits either: StarterKit's
        // trailingNode appends an empty paragraph post-load so there is
        // always a typeable line under the last block.
        const body =
          canonical(serialized) === canonical(baseline.serialized)
            ? baseline.bodyText
            : serialized;
        const markdown =
          frontmatterRef.current ===
            splitFrontmatter(baseline.fullText).frontmatter &&
          body === baseline.bodyText
            ? baseline.fullText
            : joinFrontmatter(frontmatterRef.current, body);
        lastEmittedRef.current = markdown;
        onChangeRef.current(markdown);
      },
    });
    baselineRef.current = {
      fullText: value,
      bodyText: initial.body,
      serialized: instance.getMarkdown(),
    };
    // Automation handle for e2e and drive.mjs (local app — nothing leaks).
    (window as unknown as Record<string, unknown>).__catMarkdownEditor = {
      editor: instance,
      baseline: () => baselineRef.current,
      lastEmitted: () => lastEmittedRef.current,
    };

    const cleanups = [
      installBlockEntrances(instance.view.dom),
      installDropFlip(instance.view.dom),
      handleHolder.el ? installHandleMotion(handleHolder.el) : () => {},
      installRowDrag(instance, {
        mount,
        grip: gripRef.current!,
        indicator: indicatorRef.current!,
        tint: tintRef.current!,
      }),
    ];

    // Selection reader: the selected slice serialized back to markdown (the
    // manager serializes JSON, so wrap the slice in a doc), plus its line
    // range located in the emitted markdown text.
    const readSelection = (): EditorSelectionSnapshot | null => {
      const { from, to, empty } = instance.state.selection;
      if (empty) return null;
      const slice = instance.state.doc.slice(from, to);
      let text: string;
      try {
        // A selection inside one block yields inline content; wrapping it
        // in a paragraph keeps the serializer from treating each inline
        // node as its own block. Block-level slices are used as-is.
        const paragraph = instance.schema.nodes.paragraph;
        const content =
          slice.content.firstChild?.isInline && paragraph
            ? [paragraph.create(null, slice.content)]
            : slice.content;
        const scratch = instance.state.doc.type.create(null, content);
        text = instance.markdown?.serialize(scratch.toJSON()) ?? "";
      } catch {
        text = "";
      }
      if (!text.trim()) {
        // Fallback: plain text via the DOM serializer.
        const fragment = DOMSerializer.fromSchema(
          instance.schema,
        ).serializeFragment(slice.content);
        const holder = document.createElement("div");
        holder.appendChild(fragment);
        text = holder.textContent ?? "";
      }
      text = text.replace(/\s+$/, "");
      if (!text) return null;
      // Line range: locate the first selected line inside the full markdown.
      const full = instance.getMarkdown();
      const firstLine = text.split("\n").find((line) => line.trim()) ?? "";
      const at = firstLine ? full.indexOf(firstLine) : -1;
      if (at === -1) return { text };
      const startLine = full.slice(0, at).split("\n").length;
      return {
        text,
        startLine,
        endLine: startLine + text.split("\n").length - 1,
      };
    };
    const onFocus = () => onSelectionReaderRef.current?.(readSelection);
    const onBlur = () => {
      // Keep the reader alive through the blur that a Cmd+N/click-into-chat
      // causes: the chat pulls on ITS focus, which comes after this blur.
      // The reader is swapped when another editor focuses, and cleared on
      // unmount. (Selection state persists in PM while unfocused.)
    };
    instance.view.dom.addEventListener("focus", onFocus);
    instance.view.dom.addEventListener("blur", onBlur);
    if (document.activeElement === instance.view.dom) onFocus();

    setEditor(instance);
    instance.commands.focus("start");
    onFocus();
    return () => {
      instance.view.dom.removeEventListener("focus", onFocus);
      instance.view.dom.removeEventListener("blur", onBlur);
      onSelectionReaderRef.current?.(null);
      for (const cleanup of cleanups) cleanup();
      setEditor(null);
      instance.destroy();
    };
    // The editor is created once per mounted component; `value` flows in via
    // the sync effect below and out via onUpdate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value changes (switching files within the tab, a reload after
  // save) reset the document; our own edits round-trip through onUpdate and
  // are recognized by lastEmittedRef.
  useEffect(() => {
    if (!editor || value === lastEmittedRef.current) return;
    const next = splitFrontmatter(value);
    if (
      next.body === editor.getMarkdown() &&
      next.frontmatter === frontmatterRef.current
    ) {
      return;
    }
    lastEmittedRef.current = value;
    frontmatterRef.current = next.frontmatter;
    setFrontmatterState(next.frontmatter);
    editor.commands.setContent(next.body, { contentType: "markdown" });
    baselineRef.current = {
      fullText: value,
      bodyText: next.body,
      serialized: editor.getMarkdown(),
    };
  }, [editor, value]);

  // Frontmatter edits emit through the same channel as document edits, so
  // the host's draft/dirty tracking treats them identically.
  const changeFrontmatter = (next: string) => {
    const normalized = next.trim() === "" ? null : next;
    frontmatterRef.current = normalized;
    // Keep the raw text in state so the textarea doesn't fight mid-edit;
    // only emission normalizes (an emptied block is dropped entirely).
    setFrontmatterState(next);
    const baseline = baselineRef.current;
    if (!editor || !baseline) return;
    const serialized = editor.getMarkdown();
    const body =
      canonical(serialized) === canonical(baseline.serialized)
        ? baseline.bodyText
        : serialized;
    const markdown =
      normalized === splitFrontmatter(baseline.fullText).frontmatter &&
      body === baseline.bodyText
        ? baseline.fullText
        : joinFrontmatter(normalized, body);
    lastEmittedRef.current = markdown;
    onChangeRef.current(markdown);
  };

  return (
    <div
      className="cat-mdedit-pane"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "s") {
          event.preventDefault();
          onSaveRef.current?.();
        }
      }}
    >
      <div className="cat-mdedit-scroll">
        <div ref={mountRef} className="cat-mdedit">
          {frontmatter !== null && (
            <div className="cat-mdedit-frontmatter">
              <button
                type="button"
                onClick={() => setFrontmatterOpen((open) => !open)}
                aria-expanded={frontmatterOpen}
              >
                <ChevronRight
                  className={`size-3 transition-transform duration-150 ${
                    frontmatterOpen ? "rotate-90" : ""
                  }`}
                />
                Properties
              </button>
              {frontmatterOpen && (
                <textarea
                  value={frontmatter}
                  onChange={(event) => changeFrontmatter(event.target.value)}
                  spellCheck={false}
                  rows={Math.min(12, frontmatter.split("\n").length + 1)}
                />
              )}
            </div>
          )}
          <MarkdownBubbleMenu ref={bubbleRef} editor={editor} />
          <div ref={gripRef} className="cat-mdedit-rowgrip">
            <span
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: GRIP_DOTS_SVG }}
            />
          </div>
          <div ref={indicatorRef} className="cat-mdedit-rowindicator" />
          <div ref={tintRef} className="cat-mdedit-rowtint" />
        </div>
      </div>
    </div>
  );
}

export default MarkdownEditor;
