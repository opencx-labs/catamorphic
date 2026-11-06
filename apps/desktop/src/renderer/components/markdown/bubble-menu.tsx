import type { Editor } from "@tiptap/core";
import { Link2, RemoveFormatting } from "lucide-react";
import { Fragment, type RefObject, useEffect } from "react";

/**
 * Selection bubble menu: inline marks only. The extension decides when to
 * show and where to anchor; this bar is our DOM, styled as an app overlay.
 * Three elements, so the bar can leave as it came (motion.ts,
 * createBubbleMotion): `layer` is where the extension puts the menu,
 * `anchor` is what it shows, places and detaches, and `bar` is what you
 * see, animated in and out. It appears on mouse LIFT, not mid-drag, and
 * keyboard selections show it at once.
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
  /** Where the extension appends the menu when it shows (`appendTo`). */
  layerRef: RefObject<HTMLDivElement | null>;
  /** The extension's `element`: shown, placed and detached by it. */
  anchorRef: RefObject<HTMLDivElement | null>;
  /** The visible bar, animated by `createBubbleMotion`. */
  barRef: RefObject<HTMLDivElement | null>;
}

export function MarkdownBubbleMenu({
  editor,
  layerRef,
  anchorRef,
  barRef,
}: MarkdownBubbleMenuProps) {
  // Reflect active marks in the buttons.
  useEffect(() => {
    const bar = barRef.current;
    if (!editor || !bar) return;
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
      editor.off("transaction", syncActive);
    };
  }, [editor, barRef]);

  return (
    // The layer has no box of its own; nothing but the menu ever lives in
    // it, so the extension moving the anchor in and out never disturbs
    // React's siblings.
    <div ref={layerRef} className="cat-mdedit-bubble-layer">
      <div
        ref={anchorRef}
        className="cat-mdedit-bubble-anchor"
        style={{ visibility: "hidden" }}
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: mouse-down is swallowed so the editor keeps its selection; the buttons inside are the controls */}
        <div
          ref={barRef}
          className="cat-mdedit-bubble"
          // Buttons act on the selection: mousedown must not steal it.
          onMouseDown={(event) => event.preventDefault()}
        >
          {MARK_BUTTONS.map(({ cmd, tip }) => (
            <Fragment key={cmd}>
              {(cmd === "code" || cmd === "clear") && (
                <span className="divider" />
              )}
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
      </div>
    </div>
  );
}
