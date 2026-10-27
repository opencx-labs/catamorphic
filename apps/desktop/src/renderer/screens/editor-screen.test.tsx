// @vitest-environment jsdom
import { focusManager, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../lib/desktop-api.js";
import { readEditorSelection } from "../lib/editor-selection.js";
import { workQueryClient } from "../lib/query-client.js";
import { EditorScreen } from "./editor-screen.js";

const gitListeners = new Set<(change: { projectId: string }) => void>();
const selection = vi.hoisted(() => ({ text: "" }));

vi.mock("@monaco-editor/react", () => ({
  default: ({
    value,
    onChange,
    onMount,
  }: {
    value: string;
    onChange: (next: string) => void;
    onMount: (editor: unknown, monaco: unknown) => void;
  }) => {
    // biome-ignore lint/correctness/useExhaustiveDependencies: Monaco calls onMount once; retained panes keep that reader across visibility changes.
    useEffect(() => {
      onMount(
        {
          addCommand() {},
          onDidChangeCursorSelection() {},
          onDidFocusEditorText() {},
          focus() {},
          getSelection: () => ({
            isEmpty: () => !selection.text,
            startLineNumber: 1,
            endLineNumber: 1,
            endColumn: selection.text.length + 1,
          }),
          getModel: () => ({ getValueInRange: () => selection.text }),
        },
        { KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 1 } },
      );
    }, []);
    return (
      <textarea
        data-testid="editor"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  },
}));
vi.mock("../components/file-inspector.js", () => ({
  FileInspector: () => null,
}));
vi.mock("../lib/theme.js", () => ({ useTheme: () => null }));
vi.mock("../lib/monaco-setup.js", () => ({ useMonacoTheme: () => "dark" }));
vi.mock("../lib/local-project-files.js", () => ({
  localEditorPath: async (_projectId: string, filePath: string) =>
    `/projects/p1/${filePath}`,
}));
vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    editorFileRead: vi.fn(),
    editorFileWrite: vi.fn(),
    projectRoot: vi.fn().mockResolvedValue("/projects/p1"),
    onGitChanged: vi.fn((listener: (change: { projectId: string }) => void) => {
      gitListeners.add(listener);
      return () => gitListeners.delete(listener);
    }),
  },
}));

beforeEach(() => {
  gitListeners.clear();
  selection.text = "";
  vi.mocked(desktopApi.editorFileRead).mockReset();
});

async function mount(active = true) {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const client = workQueryClient({ retry: 0, staleTime: 0 });
  const render = (shown: boolean) =>
    root.render(
      <QueryClientProvider client={client}>
        <EditorScreen
          active={shown}
          projectId="p1"
          filePath="notes.txt"
          onFindFile={() => {}}
          onDirtyChange={() => {}}
        />
      </QueryClientProvider>,
    );
  await act(async () => render(active));
  const editor = () =>
    node.querySelector<HTMLTextAreaElement>("[data-testid=editor]");
  await settle(() => editor() !== null);
  return {
    editor,
    root,
    screen: node.querySelector<HTMLElement>("[data-editor-toolbar]")
      ?.parentElement,
    setActive: (shown: boolean) => act(async () => render(shown)),
  };
}

it("does not ask the browser to lay out an inactive editor's selection", async () => {
  vi.mocked(desktopApi.editorFileRead).mockResolvedValue({ content: "before" });
  selection.text = "selected words";
  const mounted = await mount(false);
  const visible = vi.fn(() => true);
  Object.defineProperty(mounted.screen, "checkVisibility", { value: visible });
  try {
    expect(readEditorSelection()).toBeNull();
    expect(visible).not.toHaveBeenCalled();
    await mounted.setActive(true);
    expect(readEditorSelection()).toMatchObject({
      filePath: "notes.txt",
      text: "selected words",
    });
    expect(visible).toHaveBeenCalledTimes(1);
    await mounted.setActive(false);
    expect(readEditorSelection()).toBeNull();
    expect(visible).toHaveBeenCalledTimes(1);
  } finally {
    act(() => mounted.root.unmount());
  }
});

it("needs no browser visibility read when the visible editor has no selection", async () => {
  vi.mocked(desktopApi.editorFileRead).mockResolvedValue({ content: "before" });
  const mounted = await mount();
  const visible = vi.fn(() => true);
  Object.defineProperty(mounted.screen, "checkVisibility", { value: visible });
  try {
    expect(readEditorSelection()).toBeNull();
    expect(visible).not.toHaveBeenCalled();
  } finally {
    act(() => mounted.root.unmount());
  }
});

it("still excludes a selected editor hidden by CSS while its pane is active", async () => {
  vi.mocked(desktopApi.editorFileRead).mockResolvedValue({ content: "before" });
  selection.text = "selected words";
  const mounted = await mount();
  const visible = vi.fn(() => false);
  Object.defineProperty(mounted.screen, "checkVisibility", { value: visible });
  try {
    expect(readEditorSelection()).toBeNull();
    expect(visible).toHaveBeenCalledTimes(1);
  } finally {
    act(() => mounted.root.unmount());
  }
});

// React Query delivers results on a timer; let a few run.
async function settle(done: () => boolean = () => false) {
  for (let i = 0; i < 5 && !done(); i += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

async function type(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setValue?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function gitChanged(projectId: string) {
  await act(async () => {
    for (const listener of gitListeners) listener({ projectId });
  });
  await settle();
}

it("shows a settled agent turn's change to the open file", async () => {
  vi.mocked(desktopApi.editorFileRead).mockResolvedValueOnce({
    content: "before",
  });
  const { editor, root } = await mount();
  expect(editor()?.value).toBe("before");

  vi.mocked(desktopApi.editorFileRead).mockResolvedValue({ content: "after" });
  await gitChanged("another-project");
  expect(editor()?.value).toBe("before");
  await gitChanged("p1");
  expect(editor()?.value).toBe("after");
  act(() => root.unmount());
});

it("keeps an unsaved draft and the content it started from", async () => {
  vi.mocked(desktopApi.editorFileRead).mockResolvedValueOnce({
    content: "before",
  });
  const { editor, root } = await mount();
  const textarea = editor();
  if (!textarea) throw new Error("editor did not mount");
  await type(textarea, "my draft");
  expect(editor()?.value).toBe("my draft");

  vi.mocked(desktopApi.editorFileRead).mockResolvedValue({ content: "after" });
  await gitChanged("p1");
  expect(editor()?.value).toBe("my draft");
  expect(desktopApi.editorFileRead).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});

it("reads the open file again when its window is back, unless a draft holds it", async () => {
  vi.mocked(desktopApi.editorFileRead).mockResolvedValueOnce({
    content: "before",
  });
  const { editor, root } = await mount();
  const back = async () => {
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await settle();
  };
  try {
    // Changed in another app while Work was in the background.
    vi.mocked(desktopApi.editorFileRead).mockResolvedValue({
      content: "after",
    });
    await back();
    expect(editor()?.value).toBe("after");

    const textarea = editor();
    if (!textarea) throw new Error("editor did not mount");
    await type(textarea, "my draft");
    vi.mocked(desktopApi.editorFileRead).mockResolvedValue({
      content: "later",
    });
    await back();
    expect(editor()?.value).toBe("my draft");
    expect(desktopApi.editorFileRead).toHaveBeenCalledTimes(2);
  } finally {
    focusManager.setFocused(undefined);
    act(() => root.unmount());
  }
});
