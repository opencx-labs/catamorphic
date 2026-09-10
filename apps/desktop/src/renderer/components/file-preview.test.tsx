// @vitest-environment jsdom
import type { ResourcePreview } from "@catamorphic/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FilePreview } from "./file-preview";

const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../lib/desktop-api", () => ({ desktopApi: { filePreview: read } }));
function deferred() {
  let resolve: (value: ResourcePreview) => void = () => {};
  const promise = new Promise<ResourcePreview>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  read.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
});
it("ignores stale preview reads after the reference changes", async () => {
  const first = deferred();
  const second = deferred();
  read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await act(async () => root.render(<FilePreview filePath="/first.txt" />));
  await act(async () => root.render(<FilePreview filePath="/second.txt" />));
  await act(async () =>
    second.resolve({
      name: "second.txt",
      typeLabel: "Text",
      content: { kind: "text", text: "Current content" },
    }),
  );
  await act(async () =>
    first.resolve({
      name: "first.txt",
      typeLabel: "Text",
      content: { kind: "text", text: "Stale content" },
    }),
  );
  expect(container.textContent).toContain("Current content");
  expect(container.textContent).not.toContain("Stale content");
});
it("retains inline document names on errors and makes retry actionable", async () => {
  read.mockRejectedValueOnce(new Error("Missing")).mockResolvedValueOnce({
    name: "report.pdf",
    typeLabel: "PDF",
    content: { kind: "unavailable", message: "Unsupported document" },
  });
  const document = {
    name: "report.pdf",
    mediaType: "application/pdf",
    dataBase64: "data",
  };
  await act(async () => root.render(<FilePreview document={document} />));
  expect(container.textContent).toContain("report.pdf");
  expect(container.textContent).toContain("cannot be read");
  await act(async () => container.querySelector("button")?.click());
  expect(read).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("Unsupported document");
});
