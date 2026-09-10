// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ReviewCommentComposer } from "./review-comment-composer.js";

it("preserves failed drafts and submits only once until the request settles", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.setItem("draft-test", "Review **feedback**");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const post = vi.fn().mockRejectedValueOnce(new Error("Not confirmed"));
  try {
    await act(async () =>
      root.render(
        <ReviewCommentComposer draftKey="draft-test" onPost={post} />,
      ),
    );
    const form = host.querySelector("form");
    await act(async () => {
      form?.requestSubmit();
      form?.requestSubmit();
    });
    expect(post).toHaveBeenCalledOnce();
    expect(host.querySelector("textarea")?.value).toBe("Review **feedback**");
    expect(localStorage.getItem("draft-test")).toBe("Review **feedback**");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Not confirmed",
    );
    post.mockResolvedValueOnce(undefined);
    await act(async () => form?.requestSubmit());
    expect(host.querySelector("textarea")?.value).toBe("");
    expect(localStorage.getItem("draft-test")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    localStorage.removeItem("draft-test");
  }
});
