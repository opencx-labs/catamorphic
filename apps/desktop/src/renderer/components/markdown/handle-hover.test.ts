// @vitest-environment jsdom
import { Editor, Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { expect, it } from "vitest";
import { createHandleHoverGate } from "./handle-hover.js";

it("holds a move only while it is on the block the handle points at, wherever that block has moved", () => {
  const gate = createHandleHoverGate();
  // Stands in for the drag handle's plugin, after the gate.
  const seen: string[] = [];
  const handle = Extension.create({
    name: "handleStandIn",
    addProseMirrorPlugins: () => [
      new Plugin({
        props: {
          handleDOMEvents: {
            mousemove: (_view, event) => {
              seen.push(
                event.target instanceof Element
                  ? (event.target.textContent ?? "")
                  : "",
              );
              return false;
            },
          },
        },
      }),
    ],
  });
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit, gate.extension, handle],
    content: "<p>One</p><p>Two</p><ul><li><p>Item</p></li></ul>",
  });
  const { view } = editor;
  const [one, two, list] = view.dom.children;
  if (!one || !two || !list) throw new Error("expected three blocks");
  const move = (target: Element | undefined, buttons = 0) =>
    target?.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, buttons }),
    );

  gate.track(view, 0, editor.state.doc.nodeAt(0));
  // The block above it growing moves it without any resize; the move's
  // target still says where the pointer is.
  move(one);
  move(two);
  // A press held (a drag selecting text) always reaches the handle.
  move(one, 1);
  expect(seen).toEqual(["Two", "One"]);

  // A list holds other drag targets: never held.
  seen.length = 0;
  gate.track(view, 10, editor.state.doc.nodeAt(10));
  move(list);
  expect(seen).toEqual(["Item"]);

  // An edit can give the element to another position (here the held
  // paragraph's element now shows the new first one): let go.
  seen.length = 0;
  gate.track(view, 0, editor.state.doc.nodeAt(0));
  editor.commands.insertContentAt(0, "<p>Zero</p>");
  move(one);
  expect(seen).toHaveLength(1);

  // The handle hiding lets go too.
  seen.length = 0;
  gate.track(view, 0, editor.state.doc.nodeAt(0));
  gate.track(view, -1, null);
  move(view.dom.children[0]);
  expect(seen).toEqual(["Zero"]);
  editor.destroy();
});
