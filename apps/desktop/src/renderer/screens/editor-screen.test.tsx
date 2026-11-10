// @vitest-environment jsdom
import { focusManager, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../lib/desktop-api.js";
import { readEditorSelection } from "../lib/editor-selection.js";
import { workQueryClient } from "../lib/query-client.js";
import { flushWorkspaceSaves } from "../lib/workspace-persistence.js";
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
vi.mock("../components/markdown/markdown-editor.js", () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (next: string) => void;
  }) => (
    <textarea
      data-testid="editor"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
vi.mock("../components/file-inspector.js", () => ({
  FileInspector: () => null,
}));
vi.mock("../lib/theme.js", () => ({
  useTheme: () => null,
  themeStyle: () => ({}),
}));
vi.mock("../lib/monaco-setup.js", () => ({ useMonacoTheme: () => "dark" }));
vi.mock("../lib/local-project-files.js", () => ({
  localEditorPath: async (_projectId: string, filePath: string) =>
    `/projects/p1/${filePath}`,
}));
vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    editorFileRead: vi.fn(),
    editorFileWrite: vi.fn(),
    editorFileRename: vi.fn(),
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
  vi.mocked(desktopApi.editorFileWrite)
    .mockReset()
    .mockResolvedValue(undefined);
});

afterEach(() => vi.useRealTimers());

async function mount(
  active = true,
  filePath = "notes.txt",
  onSaveBeforeClose?: (save: (() => Promise<void>) | null) => void,
) {
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
          filePath={filePath}
          onSaveBeforeClose={onSaveBeforeClose}
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

it("names an untitled file when it is first saved, and the tab follows it", async () => {
  vi.mocked(desktopApi.editorFileRead).mockResolvedValue({ content: "" });
  vi.mocked(desktopApi.editorFileWrite).mockResolvedValue(undefined);
  vi.mocked(desktopApi.editorFileRename).mockResolvedValue(
    "/projects/p1/.work/personal/me/Plan.txt",
  );
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const onRename = vi.fn();
  await act(async () =>
    root.render(
      <QueryClientProvider client={workQueryClient({ retry: 0, staleTime: 0 })}>
        <EditorScreen
          active
          projectId="p1"
          filePath=".work/personal/me/Untitled.txt"
          onFindFile={() => {}}
          onDirtyChange={() => {}}
          onRename={onRename}
        />
      </QueryClientProvider>,
    ),
  );
  const editor = () =>
    node.querySelector<HTMLTextAreaElement>("[data-testid=editor]");
  await settle(() => editor() !== null);
  try {
    const textarea = editor();
    if (!textarea) throw new Error("editor did not mount");
    await type(textarea, "# Plan\nfirst steps");
    await act(async () =>
      node
        .querySelector<HTMLButtonElement>("[data-testid=editor-save]")
        ?.click(),
    );
    expect(desktopApi.editorFileWrite).not.toHaveBeenCalled();
    const name = document.querySelector<HTMLInputElement>("input[name=name]");
    expect(name?.value).toBe("Plan");
    await act(async () => name?.form?.requestSubmit());
    await settle(() => onRename.mock.calls.length > 0);
    expect(desktopApi.editorFileWrite).toHaveBeenCalledWith({
      filePath: "/projects/p1/.work/personal/me/Untitled.txt",
      content: "# Plan\nfirst steps",
      expectedContent: "",
    });
    expect(desktopApi.editorFileRename).toHaveBeenCalledWith({
      filePath: "/projects/p1/.work/personal/me/Untitled.txt",
      name: "Plan",
    });
    expect(onRename).toHaveBeenCalledWith(".work/personal/me/Plan.txt");
  } finally {
    act(() => root.unmount());
  }
});

it("autosaves Markdown edits in order, including an undo during an in-flight write", async () => {
  vi.mocked(desktopApi.editorFileRead).mockResolvedValue({
    content: "original",
  });
  const { editor, root } = await mount(true, "notes.md");
  vi.useFakeTimers();
  let finish: (() => void) | undefined;
  vi.mocked(desktopApi.editorFileWrite).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  try {
    expect(desktopApi.editorFileWrite).not.toHaveBeenCalled();
    const textarea = editor();
    if (!textarea) throw new Error("editor did not mount");
    await type(textarea, "first edit");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(550);
    });
    expect(desktopApi.editorFileWrite).toHaveBeenCalledWith({
      filePath: "/projects/p1/notes.md",
      content: "first edit",
      expectedContent: "original",
    });
    await type(textarea, "original");
    await act(async () => {
      finish?.();
      await vi.advanceTimersByTimeAsync(10);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(550);
    });
    expect(desktopApi.editorFileWrite).toHaveBeenLastCalledWith({
      filePath: "/projects/p1/notes.md",
      content: "original",
      expectedContent: "first edit",
    });
    expect(desktopApi.editorFileWrite).toHaveBeenCalledTimes(2);
    expect(editor()?.value).toBe("original");
  } finally {
    act(() => root.unmount());
  }
});

it("keeps a conflicting Markdown draft visible and exposes the failed save to close", async () => {
  vi.mocked(desktopApi.editorFileRead).mockResolvedValue({
    content: "original",
  });
  vi.mocked(desktopApi.editorFileWrite).mockRejectedValue(
    new Error("This file changed on disk"),
  );
  const saving: { close: (() => Promise<void>) | null } = { close: null };
  const { editor, root } = await mount(true, "notes.markdown", (save) => {
    saving.close = save;
  });
  vi.useFakeTimers();
  try {
    const textarea = editor();
    if (!textarea) throw new Error("editor did not mount");
    await type(textarea, "my draft");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(550);
    });
    expect(editor()?.value).toBe("my draft");
    expect(document.body.textContent).toContain("This file changed on disk");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(desktopApi.editorFileWrite).toHaveBeenCalledTimes(1);
    await act(async () => {
      await expect(saving.close?.()).rejects.toThrow("changed on disk");
    });
    expect(editor()?.value).toBe("my draft");
    vi.mocked(desktopApi.editorFileRead).mockResolvedValue({
      content: "agent edit",
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>("[data-testid=editor-reload]")
        ?.click();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(editor()?.value).toBe("agent edit");
  } finally {
    act(() => root.unmount());
  }
});

it("flushes typing that arrives while a document is saving before close", async () => {
  vi.mocked(desktopApi.editorFileRead).mockResolvedValue({
    content: "original",
  });
  const saving: { close: (() => Promise<void>) | null } = { close: null };
  const { editor, root } = await mount(true, "notes.md", (save) => {
    saving.close = save;
  });
  let finish: (() => void) | undefined;
  vi.mocked(desktopApi.editorFileWrite).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  try {
    const textarea = editor();
    if (!textarea) throw new Error("editor did not mount");
    await type(textarea, "first edit");
    const close = saving.close?.();
    await settle(() => finish !== undefined);
    await type(textarea, "last edit");
    await act(async () => {
      finish?.();
      await close;
    });
    expect(desktopApi.editorFileWrite).toHaveBeenLastCalledWith({
      filePath: "/projects/p1/notes.md",
      content: "last edit",
      expectedContent: "first edit",
    });
    expect(desktopApi.editorFileWrite).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
  }
});

it("joins the app Quit flush before the autosave debounce and reports conflicts", async () => {
  vi.mocked(desktopApi.editorFileRead).mockResolvedValue({
    content: "original",
  });
  const { editor, root } = await mount(true, "notes.md");
  vi.useFakeTimers();
  try {
    const textarea = editor();
    if (!textarea) throw new Error("editor did not mount");
    await type(textarea, "last words before Quit");
    expect(desktopApi.editorFileWrite).not.toHaveBeenCalled();
    await act(async () => {
      await flushWorkspaceSaves();
    });
    expect(desktopApi.editorFileWrite).toHaveBeenCalledWith({
      filePath: "/projects/p1/notes.md",
      content: "last words before Quit",
      expectedContent: "original",
    });
    await type(textarea, "conflicting draft");
    vi.mocked(desktopApi.editorFileWrite).mockRejectedValueOnce(
      new Error("changed on disk"),
    );
    await act(async () => {
      await expect(flushWorkspaceSaves()).rejects.toThrow("changed on disk");
    });
    expect(editor()?.value).toBe("conflicting draft");
  } finally {
    act(() => root.unmount());
  }
});

it("fences an older clean-file read before committing a successful autosave", async () => {
  vi.mocked(desktopApi.editorFileRead).mockResolvedValue({
    content: "original",
  });
  const { editor, root } = await mount(true, "notes.md");
  let finishRead: ((value: { content: string }) => void) | undefined;
  vi.mocked(desktopApi.editorFileRead).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRead = resolve;
      }),
  );
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await settle(() => finishRead !== undefined);
  expect(finishRead).toBeDefined();
  vi.useFakeTimers();
  try {
    const textarea = editor();
    if (!textarea) throw new Error("editor did not mount");
    await type(textarea, "saved edit");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(550);
    });
    await act(async () => {
      finishRead?.({ content: "original" });
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(editor()?.value).toBe("saved edit");
    await type(textarea, "next edit");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(550);
    });
    expect(desktopApi.editorFileWrite).toHaveBeenLastCalledWith({
      filePath: "/projects/p1/notes.md",
      content: "next edit",
      expectedContent: "saved edit",
    });
  } finally {
    focusManager.setFocused(undefined);
    act(() => root.unmount());
  }
});
