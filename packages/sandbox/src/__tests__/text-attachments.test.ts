import { describe, expect, it } from "vitest";
import {
  describeTextSource,
  isMediaAttachment,
  isTextAttachment,
  renderTextAttachments,
} from "../coding-agent/text-attachments.js";
import type { AgentAttachment } from "../coding-agent/types.js";

const image: AgentAttachment = {
  kind: "image",
  name: "shot.png",
  mediaType: "image/png",
  dataBase64: "AAAA",
};

describe("text attachments", () => {
  it("classifies kinds", () => {
    const text: AgentAttachment = {
      kind: "text",
      name: "note",
      text: "hi",
      source: { type: "paste" },
    };
    expect(isTextAttachment(text)).toBe(true);
    expect(isMediaAttachment(text)).toBe(false);
    expect(isTextAttachment(image)).toBe(false);
    expect(isMediaAttachment(image)).toBe(true);
  });

  it("describes every source shape", () => {
    expect(
      describeTextSource({
        kind: "text",
        name: "",
        text: "",
        source: { type: "paste" },
      }),
    ).toBe("Pasted text");
    expect(
      describeTextSource({
        kind: "text",
        name: "",
        text: "",
        source: {
          type: "selection",
          filePath: "docs/plan.md",
          startLine: 12,
          endLine: 24,
        },
      }),
    ).toBe("Selected in docs/plan.md, lines 12–24");
    expect(
      describeTextSource({
        kind: "text",
        name: "",
        text: "",
        source: {
          type: "selection",
          filePath: "a.md",
          startLine: 3,
          endLine: 3,
        },
      }),
    ).toBe("Selected in a.md, line 3");
    expect(
      describeTextSource({
        kind: "text",
        name: "",
        text: "",
        source: { type: "selection", filePath: "a.md" },
      }),
    ).toBe("Selected in a.md");
    expect(
      describeTextSource({
        kind: "text",
        name: "",
        text: "",
        source: { type: "url", url: "https://x.y" },
      }),
    ).toBe("URL: https://x.y");
    expect(
      describeTextSource({
        kind: "text",
        name: "",
        text: "",
        source: { type: "path", path: "/tmp/f" },
      }),
    ).toBe("File path: /tmp/f");
  });

  it("renders nothing without text attachments", () => {
    expect(renderTextAttachments([])).toBe("");
    expect(renderTextAttachments([image])).toBe("");
  });

  it("fences pastes and selections, leaves references bare, numbers them", () => {
    const out = renderTextAttachments([
      image,
      {
        kind: "text",
        name: "p",
        text: "line 1\n```\nfence\n```",
        source: { type: "paste" },
      },
      {
        kind: "text",
        name: "u",
        text: "https://x.y",
        source: { type: "url", url: "https://x.y" },
      },
    ]);
    expect(out).toContain(
      "[Attached context 1/2 — Pasted text]\n<<<\nline 1\n```\nfence\n```\n>>>",
    );
    expect(out).toContain("[Attached context 2/2 — URL: https://x.y]");
    // the URL block is bare — no fence follows its header
    expect(
      out.split("[Attached context 2/2 — URL: https://x.y]")[1]?.trim(),
    ).toBe("");
    expect(out.startsWith("\n\n")).toBe(true);
  });
});
