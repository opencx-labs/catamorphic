import type { Editor } from "@tiptap/core";
import { Link2, RemoveFormatting } from "lucide-react";
import { Fragment, forwardRef, useEffect, useRef } from "react";
import { EASE_STANDARD } from "./motion.js";

/**
 * Selection bubble menu: inline marks only. The extension decides when to
 * show and where to anchor; this bar is our DOM, styled as an app overlay.
 * It appears on mouse LIFT, not mid-drag: while the button is down over the
 * editor a .suppressed class hides it, and release reveals it with the
 * entrance animation. Keyboard selections show immediately.
 */

const MARK_BUTTONS = [
  { cmd: "bold", tip: "Bold ⌘B" },
  { cmd: "italic", tip: "Italic ⌘I" },
  { cmd: "strike", tip: "Strikethrough ⌘⇧S" },
  { cmd: "code", tip: "Inline code ⌘E" },
  { cmd: "link", tip: "Link" },
  { cmd: "clear", tip: "Clear formatting" },
] as const;

type MarkCommand = (typeof MARK_BUTTONS)[number]["cmd"];

function runCommand(editor: Editor, cmd: MarkCommand) {
  const chain = editor.chain().focus();
  switch (cmd) {
    case "bold":
      return chain.toggleBold().run();
    case "italic":
      return chain.toggleItalic().run();
    case "strike":
      return chain.toggleStrike().run();
    case "code":
      return chain.toggleCode().run();
    case "link": {
      if (editor.isActive("link")) return chain.unsetLink().run();
      const url = window.prompt("Link URL");
      if (url) chain.setLink({ href: url }).run();
      return;
    }
    case "clear":
      // Marks only: clearing formatting shouldn't demote a heading.
      return chain.unsetAllMarks().run();
  }
}

export interface MarkdownBubbleMenuProps {
  editor: Editor | null;
}

export const MarkdownBubbleMenu = forwardRef<
  HTMLDivElement,
  MarkdownBubbleMenuProps
>(function MarkdownBubbleMenu({ editor }, ref) {
  const barRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const bar = barRef.current;
    if (!editor || !bar) return;

    const playIn = () =>
      bar.animate(
        [
          { opacity: 0, transform: "translateY(4px) scale(0.97)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 160, easing: EASE_STANDARD },
      );

    // Entrance animation when the extension flips the element visible.
    let wasVisible = false;
    const visibility = new MutationObserver(() => {
      const visible = bar.style.visibility !== "hidden";
      if (visible && !wasVisible && !bar.classList.contains("suppressed")) {
        playIn();
      }
      wasVisible = visible;
    });
    visibility.observe(bar, { attributes: true, attributeFilter: ["style"] });

    // Appear on mouse lift, not mid-drag. Capture the DOM node now: the
    // editor may already be destroyed when this cleanup runs (tab close),
    // and tiptap's `view` getter THROWS post-destroy — removing a listener
    // from a detached node is harmless.
    const editorDom = editor.view.dom;
    const onEditorMouseDown = () => bar.classList.add("suppressed");
    const onMouseUp = () => {
      if (!bar.classList.contains("suppressed")) return;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          bar.classList.remove("suppressed");
          if (bar.style.visibility !== "hidden") playIn();
        }),
      );
    };
    editorDom.addEventListener("mousedown", onEditorMouseDown, true);
    document.addEventListener("mouseup", onMouseUp);

    // Reflect active marks in the buttons.
    const syncActive = () => {
      for (const button of bar.querySelectorAll<HTMLButtonElement>("button")) {
        const cmd = button.dataset.cmd;
        if (cmd && cmd !== "clear") {
          button.classList.toggle("is-active", editor.isActive(cmd));
        }
      }
    };
    editor.on("transaction", syncActive);

    return () => {
      visibility.disconnect();
      editorDom.removeEventListener("mousedown", onEditorMouseDown, true);
      document.removeEventListener("mouseup", onMouseUp);
      editor.off("transaction", syncActive);
    };
  }, [editor]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: mouse-down is swallowed so the editor keeps its selection; the buttons inside are the controls
    <div
      ref={(el) => {
        barRef.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      }}
      className="cat-mdedit-bubble"
      style={{ visibility: "hidden" }}
      // Buttons act on the selection — mousedown must not steal it.
      onMouseDown={(event) => event.preventDefault()}
    >
      {MARK_BUTTONS.map(({ cmd, tip }) => (
        <Fragment key={cmd}>
          {(cmd === "code" || cmd === "clear") && <span className="divider" />}
          <button
            type="button"
            data-cmd={cmd}
            data-tip={tip}
            className={cmd}
            onClick={() => editor && runCommand(editor, cmd)}
          >
            {cmd === "bold" && "B"}
            {cmd === "italic" && "I"}
            {cmd === "strike" && "S"}
            {cmd === "code" && "</>"}
            {cmd === "link" && <Link2 className="size-3.5" />}
            {cmd === "clear" && <RemoveFormatting className="size-3.5" />}
          </button>
        </Fragment>
      ))}
    </div>
  );
});
