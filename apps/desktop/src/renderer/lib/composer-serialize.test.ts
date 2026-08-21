import { ATTACHMENT_MARKER } from "@catamorphic/react";
import { describe, expect, it } from "vitest";
import {
  PILL_ATTR,
  serializeComposer,
  splitAttachmentMarkers,
  type WalkableNode,
} from "./composer-serialize";

const text = (value: string): WalkableNode => ({
  nodeType: 3,
  nodeName: "#text",
  nodeValue: value,
  childNodes: [],
});
const el = (
  name: string,
  children: WalkableNode[] = [],
  attrs: Record<string, string> = {},
): WalkableNode => ({
  nodeType: 1,
  nodeName: name,
  childNodes: children,
  getAttribute: (key) => attrs[key] ?? null,
});
const pill = (id: string) =>
  el("SPAN", [text("pill label")], { [PILL_ATTR]: id });
const M = ATTACHMENT_MARKER;

describe("serializeComposer", () => {
  it("reads text, pills (in order) and line breaks", () => {
    const root = el("DIV", [
      text("look at "),
      pill("a"),
      text(" and "),
      pill("b"),
      el("BR"),
      text("thanks "),
    ]);
    const out = serializeComposer(root, (id) => ({ id }));
    expect(out.message).toBe(`look at ${M} and ${M}\nthanks`);
    expect(out.attachments).toEqual([{ id: "a" }, { id: "b" }]);
    expect(out.text).toBe("look at  and \nthanks");
  });

  it("skips pills the resolver disowns (mid-exit) and their markers", () => {
    const root = el("DIV", [text("x "), pill("gone"), text(" y")]);
    const out = serializeComposer(root, (id) =>
      id === "gone" ? null : { id },
    );
    expect(out.message).toBe("x  y");
    expect(out.attachments).toEqual([]);
  });

  it("treats block children as line breaks, once", () => {
    const root = el("DIV", [
      text("first"),
      el("DIV", [text("second")]),
      el("DIV", [el("BR")]),
      el("DIV", [text("fourth")]),
    ]);
    expect(serializeComposer(root, () => null).message).toBe(
      "first\nsecond\n\nfourth",
    );
  });

  it("strips literal U+FFFC from prose so pasted text can't forge markers", () => {
    // Word/PDF text flavors carry object-replacement chars; only pill
    // ELEMENTS may produce markers, or positional mapping shifts.
    const root = el("DIV", [
      text(`before ${M} after`),
      el("SPAN", [], { [PILL_ATTR]: "p1" }),
    ]);
    const result = serializeComposer(root, () => "att" as const);
    expect(result.message).toBe(`before  after${M}`);
    expect(result.attachments).toEqual(["att"]);
  });

  it("is empty for the empty editable (and Chromium's leftover <br>)", () => {
    expect(serializeComposer(el("DIV", [el("BR")]), () => null)).toEqual({
      message: "",
      attachments: [],
      text: "",
    });
  });
});

describe("splitAttachmentMarkers", () => {
  it("interleaves runs and numbered slots", () => {
    expect(splitAttachmentMarkers(`a ${M}${M} b`)).toEqual([
      { type: "text", text: "a " },
      { type: "pill", index: 0 },
      { type: "pill", index: 1 },
      { type: "text", text: " b" },
    ]);
    expect(splitAttachmentMarkers("plain")).toEqual([
      { type: "text", text: "plain" },
    ]);
    expect(splitAttachmentMarkers("")).toEqual([]);
  });
});
