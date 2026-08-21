import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_MARKER,
  messageWithAttachmentNames,
} from "./use-send-agent-message.js";

describe("messageWithAttachmentNames", () => {
  const M = ATTACHMENT_MARKER;
  it("names markers in order and drops those past the list", () => {
    expect(
      messageWithAttachmentNames(`fix ${M} using ${M}${M}`, [
        { name: "sel.md · 3" },
        { name: "shot.png" },
      ]),
    ).toBe("fix [sel.md · 3] using [shot.png]");
  });
  it("leaves marker-less prose untouched", () => {
    expect(messageWithAttachmentNames("plain", undefined)).toBe("plain");
  });
});
