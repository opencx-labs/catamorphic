import { describe, expect, it } from "vitest";
import {
  chatBookmarkUrl,
  parseChatBookmarkUrl,
} from "../../shared/bookmark-target.js";
import { readBookmarkDrop } from "./bookmark-drag.js";

const drop = (value: unknown) =>
  readBookmarkDrop({ getData: () => JSON.stringify(value) });

describe("bookmark drag destinations", () => {
  it("uses a stable conversation link instead of the temporary tab id", () => {
    const url = chatBookmarkUrl({
      projectId: "project with spaces",
      sessionId: "session/one",
    });
    expect(
      drop({
        kind: "chat",
        key: "chat:temporary",
        title: "Research",
        bookmarkUrl: url,
      }),
    ).toEqual({ label: "Research", url });
    expect(parseChatBookmarkUrl(url)).toEqual({
      projectId: "project with spaces",
      sessionId: "session/one",
    });
  });
  it("accepts browser pages and rejects executable or incomplete targets", () => {
    expect(
      drop({
        kind: "browser",
        title: "Docs",
        detail: "https://example.test/docs",
      }),
    ).toEqual({ label: "Docs", url: "https://example.test/docs" });
    expect(
      drop({ kind: "browser", bookmarkUrl: "javascript:alert(1)" }),
    ).toBeNull();
    expect(drop({ kind: "chat", key: "chat:unsaved" })).toBeNull();
    expect(drop({ kind: "terminal", detail: "/tmp" })).toBeNull();
    expect(drop(null)).toBeNull();
    expect(parseChatBookmarkUrl("catamorphic://chat?project=p")).toBeNull();
  });
});
