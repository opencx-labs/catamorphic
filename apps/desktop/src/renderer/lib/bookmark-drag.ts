import { parseChatBookmarkUrl } from "../../shared/bookmark-target.js";
import { TAB_DRAG_TYPE } from "./tab-drag.js";

/** Drag data can come from another page; accept only supported destinations. */
export function readBookmarkDrop(
  data: Pick<DataTransfer, "getData">,
): { label: string; url: string } | null {
  try {
    const value: unknown = JSON.parse(data.getData(TAB_DRAG_TYPE));
    if (typeof value !== "object" || value === null || !("kind" in value))
      return null;
    if (
      value.kind !== "browser" &&
      value.kind !== "chat" &&
      value.kind !== "bookmark"
    )
      return null;
    const url =
      "bookmarkUrl" in value && typeof value.bookmarkUrl === "string"
        ? value.bookmarkUrl
        : "detail" in value && typeof value.detail === "string"
          ? value.detail
          : "";
    const parsed = new URL(url);
    if (
      !parseChatBookmarkUrl(url) &&
      !["http:", "https:", "file:"].includes(parsed.protocol)
    )
      return null;
    const label =
      "title" in value && typeof value.title === "string" ? value.title : url;
    return { label, url };
  } catch {
    return null;
  }
}
