import { expect, it } from "vitest";
import { chatBookmarkUrl } from "../../shared/bookmark-target.js";
import { frontKeys, targetKey } from "./targets.js";

it("names the page in front by its address, as its bookmark names it", () => {
  const front = frontKeys({
    kind: "browser",
    key: "browser:b1",
    url: "https://docs.example.com/guide",
  });
  expect(front.has(targetKey("https://docs.example.com/guide") ?? "")).toBe(
    true,
  );
  expect(front.has(targetKey("https://docs.example.com/other") ?? "")).toBe(
    false,
  );
});

it("names the chat in front by its conversation", () => {
  const front = frontKeys({ kind: "chat", key: "chat:c1", sessionId: "s1" });
  expect(
    front.has(
      targetKey(chatBookmarkUrl({ projectId: "p", sessionId: "s1" })) ?? "",
    ),
  ).toBe(true);
});
