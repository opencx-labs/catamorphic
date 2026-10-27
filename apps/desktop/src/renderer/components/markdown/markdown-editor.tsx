import { Editor } from "@tiptap/core";
import BubbleMenu from "@tiptap/extension-bubble-menu";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import type {
  DragHandleOptions,
  DragHandleRule,
} from "@tiptap/extension-drag-handle";
import DragHandle from "@tiptap/extension-drag-handle";
import { TableKit } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Markdown } from "@tiptap/markdown";
import { DOMSerializer } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { ChevronRight } from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { MarkdownBubbleMenu } from "./bubble-menu.js";
import { joinFrontmatter, splitFrontmatter } from "./frontmatter.js";
import { MarkdownGuardrails } from "./guardrails.js";
import { createHandleHoverGate } from "./handle-hover.js";
import {
  ImageLink,
  ImageParagraph,
  imageLocation,
  MarkdownImage,
} from "./image.js";
import { lowlight } from "./lowlight.js";
import {
  createBubbleMotion,
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
  /**
   * The document's path relative to its project: where its images'
   * relative paths start. Without one (or for a document outside a
   * project) only web images show.
   */
  documentPath?: string;
  /**
   * Reads an image in the project (a path relative to it) as a URL to
   * show, or null.
   */
  readImage?: (path: string) => Promise<string | null>;
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

type HandleReference = ReturnType<
  NonNullable<DragHandleOptions["getReferencedVirtualElement"]>
>;

/**
 * Where the drag handle points: the hovered block's left edge, at the
 * vertical center of its first line. The extension aligns the handle's top
 * with the block's top, which suits only a one-line paragraph; a heading's
 * taller line, a code block's padding, a table's border and cell padding
 * and a rule's own box all put the grip off its line. Centered on this
 * reference (placement "left"), it rides the first line of every block.
 * That line is the block's first textblock (a table's first cell, a list
 * item's own paragraph, a code block); a textblock without text, or a
 * block with none (a rule), is centered on its own box, one line tall.
 */
function firstLineReference(view: EditorView, pos: number): HandleReference {
  const { doc } = view.state;
  if (pos < 0 || pos >= doc.content.size) return null;
  const node = doc.nodeAt(pos);
  const block = view.nodeDOM(pos);
  if (!node || !(block instanceof HTMLElement)) return null;
  let textblockPos = node.isTextblock ? pos : -1;
  node.descendants((child, offset) => {
    if (textblockPos === -1 && child.isTextblock) {
      textblockPos = pos + 1 + offset;
    }
    return textblockPos === -1;
  });
  const textblock = textblockPos === -1 ? null : view.nodeDOM(textblockPos);
  const line = textblock instanceof HTMLElement ? textblock : block;
  return {
    getBoundingClientRect: () => {
      const box = block.getBoundingClientRect();
      return DOMRect.fromRect({
        x: box.left,
        y: firstLineCenter(line),
        width: box.width,
        height: 0,
      });
    },
  };
}

/** The vertical center of an element's first line (text or an image), or of its box. */
function firstLineCenter(element: HTMLElement): number {
  // Text, or an image before any (a figure over its caption): the first
  // line it is on.
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
  );
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Element) {
      if (node.classList.contains("cat-mdedit-image")) {
        return imageLineCenter(element, node);
      }
      continue;
    }
    const content = node.textContent ?? "";
    const start = content.search(/\S/);
    if (start === -1) continue;
    const range = document.createRange();
    // A first line with nothing on it (a code block opening with a blank
    // line): the caret's place at its start is that line.
    if (content.slice(0, start).includes("\n")) {
      range.setStart(node, 0);
      range.collapse(true);
      const caret = range.getBoundingClientRect();
      if (caret.height > 0) return caret.top + caret.height / 2;
    }
    range.setStart(node, start);
    range.setEnd(
      node,
      start + ((content.codePointAt(start) ?? 0) > 0xffff ? 2 : 1),
    );
    const rect = range.getClientRects()[0];
    if (rect && rect.height > 0) return rect.top + rect.height / 2;
  }
  const box = element.getBoundingClientRect();
  return box.top + box.height / 2;
}

/** An image's first line: a tall one keeps the handle by its top. */
function imageLineCenter(block: HTMLElement, image: Element): number {
  const box = image.getBoundingClientRect();
  const line = Number.parseFloat(getComputedStyle(block).lineHeight);
  return box.top + (line > 0 ? Math.min(box.height, line) : box.height) / 2;
}

/** Markdown equality modulo trailing blank lines. */
const canonical = (markdown: string) => markdown.replace(/\s+$/, "");

const GRIP_DOTS_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>';

export function MarkdownEditor({
  value,
  onChange,
  onSave,
  onSelectionReader,
  documentPath,
  readImage,
}: MarkdownEditorProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const bubbleLayerRef = useRef<HTMLDivElement | null>(null);
  const bubbleAnchorRef = useRef<HTMLDivElement | null>(null);
  const bubbleBarRef = useRef<HTMLDivElement | null>(null);
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
  const imagesRef = useRef({ documentPath, readImage });
  imagesRef.current = { documentPath, readImage };
  // The markdown we last emitted; external `value` changes that differ from
  // it are real (file switch, reload) and reset the document.
  const lastEmittedRef = useRef<string | null>(null);
  // An unrelated parent render can land between Tiptap's update and React
  // committing the matching controlled value. Remember the last value prop
  // we observed so that stale, unchanged props never roll back fresh typing.
  const lastValueRef = useRef(value);
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: mounts the editor once; the initial value is a seed, later values flow through the baseline diff
  useEffect(() => {
    const mount = mountRef.current;
    const bubbleLayer = bubbleLayerRef.current;
    const bubbleAnchor = bubbleAnchorRef.current;
    const bubbleBar = bubbleBarRef.current;
    if (!mount || !bubbleLayer || !bubbleAnchor || !bubbleBar) return;

    const initial = splitFrontmatter(value);
    frontmatterRef.current = initial.frontmatter;
    setFrontmatterState(initial.frontmatter);

    const bubbleMotion = createBubbleMotion({
      layer: bubbleLayer,
      anchor: bubbleAnchor,
      bar: bubbleBar,
    });
    const handleHolder: { el: HTMLElement | null } = { el: null };
    const hoverGate = createHandleHoverGate();
    const hovered: { view: EditorView | null; pos: number } = {
      view: null,
      pos: -1,
    };
    const instance = new Editor({
      element: mount,
      extensions: [
        StarterKit.configure({
          codeBlock: false,
          // Both replaced by image-aware versions (image.ts).
          link: false,
          paragraph: false,
          dropcursor: { color: "var(--color-accent)", width: 2 },
        }),
        Markdown,
        ImageLink,
        ImageParagraph,
        MarkdownImage.configure({
          resolve: async (src) => {
            const images = imagesRef.current;
            const location = imageLocation(src, images.documentPath ?? null);
            if (!location) return null;
            if ("url" in location) return location.url;
            return (await images.readImage?.(location.path)) ?? null;
          },
        }),
        TaskList,
        TaskItem.configure({ nested: true }),
        TableKit,
        CodeBlockLowlight.configure({
          lowlight,
          defaultLanguage: "plaintext",
        }),
        BubbleMenu.configure({
          element: bubbleAnchor,
          appendTo: bubbleLayer,
          // The extension's own test, but any selection without text shows
          // no bar: a picked rule has no marks to take.
          shouldShow: ({ editor: current, element, view, state, from, to }) =>
            (view.hasFocus() || element.contains(document.activeElement)) &&
            !state.selection.empty &&
            current.isEditable &&
            state.doc.textBetween(from, to).length > 0,
          options: {
            placement: "top",
            offset: 8,
            // Flip is checked before the offset applies, so it needs the
            // offset's room too, or a bar that barely fits is clipped by
            // the scroller above the first line.
            flip: { padding: 12 },
            onShow: bubbleMotion.show,
            onHide: bubbleMotion.hide,
          },
        }),
        hoverGate.extension,
        DragHandle.configure({
          nested: { rules: [DRAG_SCOPE_RULE], edgeDetection: "none" },
          // The box the extension places, and the grip that glides inside
          // it (installHandleMotion).
          render: () => {
            const el = document.createElement("div");
            el.className = "cat-mdedit-handle";
            const grip = document.createElement("div");
            grip.className = "cat-mdedit-handle-grip";
            grip.innerHTML = GRIP_DOTS_SVG;
            el.append(grip);
            handleHolder.el = el;
            return el;
          },
          // Centered on the hovered block's first line, not top-aligned
          // with its box (see firstLineReference).
          computePositionConfig: { placement: "left" },
          getReferencedVirtualElement: () =>
            hovered.view ? firstLineReference(hovered.view, hovered.pos) : null,
          onNodeChange: (change) => {
            // The plugin passes the position it is about to point at, on
            // hover and when a doc change moves it to the enclosing
            // top-level block; the option's declared type omits it.
            hovered.pos =
              change.node && "pos" in change && typeof change.pos === "number"
                ? change.pos
                : -1;
            hovered.view = change.editor.view;
            hoverGate.track(change.editor.view, hovered.pos, change.node);
            // listItem = bullet/number markers to clear; taskItem has none.
            handleHolder.el?.classList.toggle(
              "for-list-item",
              change.node?.type.name === "listItem",
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
      bubbleMotion.attach(instance.view.dom),
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
    if (!editor || value === lastValueRef.current) return;
    lastValueRef.current = value;
    if (value === lastEmittedRef.current) return;
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
    // Loading new content is not an edit: emitting it would hand the host
    // the doc's own serialization, which differs from the file, as a draft.
    editor.commands.setContent(next.body, {
      contentType: "markdown",
      emitUpdate: false,
    });
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
    // biome-ignore lint/a11y/noStaticElementInteractions: a keyboard-shortcut catcher around the editor; the editor itself is the focusable control
    <div
      className="cat-mdedit-pane"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "s") {
          event.preventDefault();
          onSaveRef.current?.();
        }
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a click in the margins places the caret; the editor itself is the focusable control */}
      <div
        className="cat-mdedit-scroll"
        onMouseDown={(event) => {
          if (editor && event.button === 0) placeCaretFromMargin(editor, event);
        }}
      >
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
          <MarkdownBubbleMenu
            editor={editor}
            layerRef={bubbleLayerRef}
            anchorRef={bubbleAnchorRef}
            barRef={bubbleBarRef}
          />
          <div ref={gripRef} className="cat-mdedit-rowgrip">
            <span
              // biome-ignore lint/security/noDangerouslySetInnerHtml: a constant inline SVG, no user content
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

/**
 * A press in the page around the text (below the last line, beside a
 * line) puts the caret where the text nearest to it is, as a page does.
 */
function placeCaretFromMargin(editor: Editor, event: ReactMouseEvent) {
  const target = event.target;
  if (
    !(target instanceof Element) ||
    !target.closest(".cat-mdedit-scroll") ||
    target.closest(
      ".ProseMirror, .cat-mdedit-frontmatter, .cat-mdedit-bubble-layer, .cat-mdedit-handle, .cat-mdedit-rowgrip",
    )
  )
    return;
  event.preventDefault();
  const dom = editor.view.dom;
  const box = dom.getBoundingClientRect();
  if (event.clientY >= box.bottom) {
    editor.commands.focus("end");
    return;
  }
  const style = getComputedStyle(dom);
  const left = box.left + Number.parseFloat(style.paddingLeft) + 1;
  const right = box.right - Number.parseFloat(style.paddingRight) - 1;
  const found = editor.view.posAtCoords({
    left: Math.min(Math.max(event.clientX, left), right),
    top: Math.min(Math.max(event.clientY, box.top + 1), box.bottom - 1),
  });
  if (found) editor.chain().focus().setTextSelection(found.pos).run();
  else editor.commands.focus("end");
}

export default MarkdownEditor;
