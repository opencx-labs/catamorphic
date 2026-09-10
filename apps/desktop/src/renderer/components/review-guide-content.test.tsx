// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ReviewGuideContent } from "./review-guide-content.js";

it("navigates rendered headings, ignores code examples, and follows edited headings", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (markdown: string) =>
    act(async () =>
      root.render(
        <ReviewGuideContent
          markdown={markdown}
          files={[]}
          onOpenFile={() => {}}
        />,
      ),
    );
  try {
    await render(
      "## First\nText\n\n```md\n## Not a section\n```\n\n## Second\nMore text",
    );
    const links = [...host.querySelectorAll<HTMLAnchorElement>("nav a")];
    expect(links.map((link) => link.textContent)).toEqual([
      "1First",
      "2Second",
    ]);
    const second = host.querySelectorAll("h2")[1];
    if (!second) throw new Error("Missing heading");
    const scroll = vi.fn();
    second.scrollIntoView = scroll;
    await act(async () => links[1]?.click());
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    expect(document.activeElement).toBe(second);
    await render("## Revised\nText\n## Another section\nText");
    expect(host.querySelector("nav")?.textContent).toContain("Revised");
    expect(host.querySelector("nav")?.textContent).not.toContain("First");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
