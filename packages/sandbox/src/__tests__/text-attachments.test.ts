import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_MARKER,
  describeTextSource,
  isMediaAttachment,
  isTextAttachment,
  messageWithAttachmentNames,
  renderTextAttachments,
  renderUserMessage,
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
    expect(
      describeTextSource({
        kind: "text",
        name: "",
        text: "",
        source: {
          type: "tab",
          key: "browser:1",
          kind: "browser",
          title: "Docs",
          url: "https://x.y/docs",
        },
      }),
    ).toBe(
      'Open browser tab "Docs" (https://x.y/docs) — key browser:1; read it with workspace_read_tab',
    );
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
    // Numbered by position in the FULL list (the image is #1) so inline
    // references and blocks agree.
    expect(out).toContain(
      "[Attachment 2: p — Pasted text]\n<<<\nline 1\n```\nfence\n```\n>>>",
    );
    expect(out).toContain("[Attachment 3: u — URL: https://x.y]");
    // the URL block is bare — no fence follows its header
    expect(out.split("[Attachment 3: u — URL: https://x.y]")[1]?.trim()).toBe(
      "",
    );
    expect(out.startsWith("\n\n")).toBe(true);
  });

  const paste: AgentAttachment = {
    kind: "text",
    name: "notes.txt",
    text: "a\nb",
    source: { type: "paste" },
  };

  it("replaces inline markers with numbered references, in order", () => {
    const M = ATTACHMENT_MARKER;
    const out = renderUserMessage(`look at ${M} and ${M} please`, [
      image,
      paste,
    ]);
    expect(
      out.startsWith(
        "look at [attachment 1: shot.png] and [attachment 2: notes.txt] please",
      ),
    ).toBe(true);
    expect(out).toContain(
      "[Attachment 2: notes.txt — Pasted text]\n<<<\na\nb\n>>>",
    );
    expect(out).not.toContain(M);
  });

  it("drops markers past the attachment list and appends marker-less ones", () => {
    const M = ATTACHMENT_MARKER;
    expect(renderUserMessage(`x ${M}${M} y`, [image])).toBe(
      "x [attachment 1: shot.png] y",
    );
    // No markers at all: the legacy shape — prose, then blocks.
    expect(renderUserMessage("hi", [paste])).toBe(
      "hi\n\n[Attachment 1: notes.txt — Pasted text]\n<<<\na\nb\n>>>",
    );
    expect(renderUserMessage("hi", undefined)).toBe("hi");
  });

  it("names attachments in plain-text renderings (titles)", () => {
    const M = ATTACHMENT_MARKER;
    expect(messageWithAttachmentNames(`fix ${M} now`, [paste])).toBe(
      "fix [notes.txt] now",
    );
    expect(messageWithAttachmentNames("plain", [])).toBe("plain");
  });
});
