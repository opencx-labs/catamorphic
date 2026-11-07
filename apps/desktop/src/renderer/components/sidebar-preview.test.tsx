// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { FilePreviewProjectContext } from "./file-preview.js";
import { PreviewCard } from "./sidebar-preview.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
vi.mock("../screens/app-screen.js", () => ({
  AppScreen: ({
    appName,
    hostContext,
  }: {
    appName: string;
    hostContext?: Record<string, unknown>;
  }) => <div data-app={appName} data-context={JSON.stringify(hostContext)} />,
}));
let root: Root;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});
it("keeps readable labels, full values, copy and custom actions in the hover card", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  const onAction = vi.fn(async () => {});
  act(() =>
    root.render(
      <PreviewCard
        fallbackTitle="Plan"
        onAction={onAction}
        preview={{
          metadata: [
            {
              label: "Next reminder",
              value: "Wednesday, February 10 at 14:00 (Asia/Amman)",
              display: "badge",
              tone: "warning",
              copy: "2027-02-10T11:00:00Z",
              actions: [{ action: "edit", label: "Change reminder" }],
            },
          ],
          content: {
            markdown:
              "**Details**\n\n- First\n- Second\n\n<script>bad()</script>",
          },
        }}
      />,
    ),
  );
  expect(node.querySelector("dt")?.className).not.toContain("uppercase");
  expect(node.querySelector("dd")?.textContent).toContain("(Asia/Amman)");
  expect(node.querySelector("dd .truncate")).toBeNull();
  expect(node.querySelector("strong")?.textContent).toBe("Details");
  expect(node.querySelectorAll("li")).toHaveLength(2);
  expect(node.querySelector("script")).toBeNull();
  await act(async () =>
    node
      .querySelector<HTMLButtonElement>('[aria-label="Copy next reminder"]')
      ?.click(),
  );
  expect(writeText).toHaveBeenCalledWith("2027-02-10T11:00:00Z");
  await act(async () =>
    [...node.querySelectorAll("button")]
      .find((b) => b.textContent === "Change reminder")
      ?.click(),
  );
  expect(onAction).toHaveBeenCalledWith({
    action: "edit",
    label: "Change reminder",
  });
});

it("mounts arbitrary inspector content as an ordinary project app with explicit data", () => {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  act(() =>
    root.render(
      <FilePreviewProjectContext.Provider value="project">
        <PreviewCard
          fallbackTitle="Task"
          preview={{ content: { app: "task-details", data: { taskId: "t1" } } }}
        />
      </FilePreviewProjectContext.Provider>,
    ),
  );
  expect(node.querySelector("[data-app]")?.getAttribute("data-app")).toBe(
    "task-details",
  );
  expect(
    JSON.parse(
      node.querySelector("[data-app]")?.getAttribute("data-context") ?? "null",
    ),
  ).toEqual({ inspector: { taskId: "t1" } });
});
