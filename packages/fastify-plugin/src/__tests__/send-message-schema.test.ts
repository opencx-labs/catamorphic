import { describe, expect, it } from "vitest";
import { SendMessageSchema } from "../schemas.js";

const textPill = {
  kind: "text",
  name: "planning-notes.md · 3",
  text: "Some selected text",
  source: {
    type: "selection",
    filePath: "planning-notes.md",
    startLine: 3,
    endLine: 3,
  },
};

describe("SendMessageSchema", () => {
  it("accepts a pill-only message (empty prose, one attachment)", () => {
    expect(
      SendMessageSchema.safeParse({ message: "", attachments: [textPill] })
        .success,
    ).toBe(true);
    expect(
      SendMessageSchema.safeParse({ message: "   ", attachments: [textPill] })
        .success,
    ).toBe(true);
  });

  it("rejects a message with neither text nor attachments", () => {
    expect(SendMessageSchema.safeParse({ message: "" }).success).toBe(false);
    expect(
      SendMessageSchema.safeParse({ message: "  ", attachments: [] }).success,
    ).toBe(false);
  });

  it("accepts every text source shape and rejects malformed ones", () => {
    for (const source of [
      { type: "paste" },
      { type: "url", url: "https://x.y" },
      { type: "path", path: "/tmp/f.md" },
      { type: "selection", filePath: "a.md" },
    ]) {
      expect(
        SendMessageSchema.safeParse({
          message: "",
          attachments: [{ kind: "text", name: "n", text: "t", source }],
        }).success,
      ).toBe(true);
    }
    expect(
      SendMessageSchema.safeParse({
        message: "",
        attachments: [
          { kind: "text", name: "n", text: "t", source: { type: "selection" } },
        ],
      }).success,
    ).toBe(false);
    expect(
      SendMessageSchema.safeParse({
        message: "",
        attachments: [
          { kind: "text", name: "n", text: "t", source: { type: "nope" } },
        ],
      }).success,
    ).toBe(false);
  });

  it("still accepts media attachments and mixes kinds", () => {
    const image = {
      kind: "image",
      name: "a.png",
      mediaType: "image/png",
      dataBase64: "AAAA",
    };
    expect(
      SendMessageSchema.safeParse({
        message: "look",
        attachments: [image, textPill],
      }).success,
    ).toBe(true);
  });

  it("caps at 32 attachments", () => {
    const many = Array.from({ length: 32 }, () => textPill);
    expect(
      SendMessageSchema.safeParse({ message: "", attachments: many }).success,
    ).toBe(true);
    expect(
      SendMessageSchema.safeParse({
        message: "",
        attachments: [...many, textPill],
      }).success,
    ).toBe(false);
  });
});
