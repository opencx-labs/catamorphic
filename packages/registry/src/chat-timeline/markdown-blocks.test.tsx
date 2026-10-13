import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import { markdownBlocks } from "./chat-timeline.js";

const html = (text: string) =>
  renderToStaticMarkup(<Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>);

/** The blocks, rendered one after another, as the reply renders them. */
const byBlocks = (text: string) => markdownBlocks(text).map(html).join("\n");

const samples: Record<string, string> = {
  paragraphs: "First thought.\n\nSecond thought,\nstill the same paragraph.",
  headings: "## Part 1\n\nThe lexer reads.\n\n## Part 2\n\nThe parser builds.",
  "a loose list": "- one\n\n- two\n\n  more of two\n\n- three",
  "an ordered list split by blank lines": "1. read\n\n2. fix\n\n3. test",
  "a fence with blank lines":
    "Code:\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nDone.",
  "a fence holding a fence":
    "````md\n```ts\nx\n```\n\nstill code\n````\n\nAfter.",
  "a tilde fence": "~~~\none\n\ntwo\n~~~\n\nAfter.",
  "a table": "Results:\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nAll good.",
  "a quote over blank lines": "> one\n>\n> two\n\nAfter.",
  references: "See [the docs][d].\n\nMore.\n\n[d]: https://example.test",
  "a rule": "Above.\n\n---\n\nBelow.",
  "an indented block": "Para.\n\n    indented code\n\nAfter.",
  "HTML pre over blank lines": "Before.\n\n<pre>\none\n\ntwo\n</pre>\n\nAfter.",
  "an HTML comment over blank lines":
    "Before.\n\n<!-- one\n\ntwo -->\n\nAfter.",
  "a style block": "<style>\na {}\n\nb {}\n</style>\n\nAfter.",
  "a script block": "<script>\nlet a;\n\nlet b;\n</script>\n\nAfter.",
  "a comment not closed yet": "Before.\n\n<!-- still\n\nopen",
  "a comment closed on its line": "Before.\n\n<!-- done -->\n\nAfter.",
};

describe("markdownBlocks", () => {
  for (const [name, text] of Object.entries(samples))
    it(`reads ${name} exactly as the whole would`, () => {
      expect(byBlocks(text)).toBe(html(text));
    });

  it("splits where a new paragraph, heading or fence starts", () => {
    expect(
      markdownBlocks("A.\n\n## B\n\nC.\n\n```\nd\n\ne\n```\n\nF."),
    ).toHaveLength(5);
  });

  it("keeps lists, quotes and tables with what precedes them", () => {
    expect(markdownBlocks("Intro.\n\n- a\n\n- b")).toHaveLength(1);
    expect(markdownBlocks("Intro.\n\n> quoted")).toHaveLength(1);
    expect(markdownBlocks("Intro.\n\n| a |\n| - |")).toHaveLength(1);
  });

  it("keeps an HTML block that runs past blank lines whole", () => {
    expect(markdownBlocks("A.\n\n<pre>\nx\n\ny\n</pre>\n\nB.")).toHaveLength(3);
    // Still open while it streams: nothing after its opener splits off.
    expect(markdownBlocks("A.\n\n<!-- x\n\ny\n\nz")).toHaveLength(2);
  });

  it("leaves text with references whole", () => {
    expect(markdownBlocks(samples.references ?? "")).toHaveLength(1);
  });

  it("grows only at its end as words arrive", () => {
    const whole = samples.headings ?? "";
    const earlier = markdownBlocks(whole.slice(0, 30));
    const later = markdownBlocks(whole);
    expect(later.slice(0, earlier.length - 1)).toEqual(earlier.slice(0, -1));
  });
});
