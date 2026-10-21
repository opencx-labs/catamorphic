// @vitest-environment jsdom

import { afterEach, expect, it } from "vitest";
import { PILL_ATTR } from "./composer-serialize";
import {
  sameTrigger,
  triggerAtCaret,
  triggerInText,
  triggerRange,
} from "./composer-trigger";

afterEach(() => document.body.replaceChildren());

it("opens from the start of any word, mid-message too", () => {
  expect(triggerInText("/")).toEqual({ char: "/", query: "", start: 0 });
  expect(triggerInText("/rev")).toEqual({ char: "/", query: "rev", start: 0 });
  expect(triggerInText("fix it and /")).toEqual({
    char: "/",
    query: "",
    start: 11,
  });
  expect(triggerInText("look at @src/lib")).toEqual({
    char: "@",
    query: "src/lib",
    start: 8,
  });
  // The editor's zero-width guard beside a pill ends a word.
  expect(triggerInText("​@sh")).toEqual({ char: "@", query: "sh", start: 1 });
});

it("leaves paths, addresses and finished words alone", () => {
  expect(triggerInText("and/or")).toBeNull();
  expect(triggerInText("src/lib")).toBeNull();
  expect(triggerInText("/usr/bin")).toBeNull();
  expect(triggerInText("https://x.y/")).toBeNull();
  expect(triggerInText("me@work.software")).toBeNull();
  expect(triggerInText("@a@b")).toBeNull();
  expect(triggerInText("/review ")).toBeNull();
  expect(triggerInText("plain words")).toBeNull();
});

function composerWith(text: string, caret = text.length) {
  const root = document.createElement("div");
  root.contentEditable = "true";
  const node = document.createTextNode(text);
  root.append(node);
  document.body.append(root);
  const range = document.createRange();
  range.setStart(node, caret);
  range.collapse(true);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
  return { root, node };
}

it("reads the word the caret ends and covers it with a range", () => {
  const { root, node } = composerWith("see @app and more", 8);
  const trigger = triggerAtCaret(root);
  expect(trigger).toMatchObject({ char: "@", query: "app", start: 4, end: 8 });
  expect(trigger && triggerRange(trigger)?.toString()).toBe("@app");
  // The word changed under it: its old range no longer holds.
  node.nodeValue = "see @xyz and more";
  expect(trigger && triggerRange(trigger)).toBeNull();
});

it("ignores a caret inside a pill or outside the composer", () => {
  const { root } = composerWith("hello");
  const host = document.createElement("span");
  host.setAttribute(PILL_ATTR, "p1");
  const label = document.createTextNode("@label");
  host.append(label);
  root.append(host);
  const range = document.createRange();
  range.setStart(label, 6);
  range.collapse(true);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
  expect(triggerAtCaret(root)).toBeNull();
  const outside = composerWith("/elsewhere");
  expect(triggerAtCaret(root)).toBeNull();
  expect(triggerAtCaret(outside.root)?.query).toBe("elsewhere");
});

it("knows a dismissed word from the next one", () => {
  const { node } = composerWith("/a");
  const first = { node, start: 0, char: "/" as const };
  expect(sameTrigger(first, { ...first })).toBe(true);
  expect(sameTrigger(first, { ...first, start: 3 })).toBe(false);
  expect(sameTrigger(first, null)).toBe(false);
});
