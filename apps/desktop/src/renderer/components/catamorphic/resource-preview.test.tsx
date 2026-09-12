// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { ResourcePreviewContent } from "./resource-preview";

it("renders Markdown structure without executing HTML, navigating links, or fetching images", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ResourcePreviewContent
          preview={{
            name: "notes.md",
            typeLabel: "MD",
            content: {
              kind: "text",
              format: "markdown",
              truncated: true,
              text: "# Project notes\n\n**Ready** for review.\n\n- First\n- Second\n\n| Name | State |\n| --- | --- |\n| Build | Done |\n\n```ts\nconst safe = true;\n```\n\n<script>alert(1)</script>\n\n[Bad](javascript:alert(1)) ![Remote image](https://example.org/pixel.png)",
            },
          }}
        />,
      ),
    );
    expect(container.querySelector("h1")?.textContent).toBe("Project notes");
    expect(container.querySelector("strong")?.textContent).toBe("Ready");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("table")?.textContent).toContain("Build");
    expect(container.querySelector("pre code")?.textContent).toContain(
      "const safe",
    );
    expect(container.querySelector("script, img, iframe, a")).toBeNull();
    expect(container.textContent).toContain("Showing the beginning");
    await act(async () =>
      root.render(
        <ResourcePreviewContent
          preview={{
            name: "notes.html",
            typeLabel: "HTML",
            content: { kind: "text", text: "<h1>Source</h1>" },
          }}
        />,
      ),
    );
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe("<h1>Source</h1>");
  } finally {
    await act(async () => root.unmount());
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  }
});
