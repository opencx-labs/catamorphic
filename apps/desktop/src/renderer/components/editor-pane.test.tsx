// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { notePersonInput, personInputCount } from "../lib/app-focus.js";
import type { EditorScreenProps } from "../screens/editor-screen.js";
import { EditorPane } from "./editor-pane.js";

const screenModule = vi.hoisted(() => {
  let finishImport = () => {};
  const ready = new Promise<void>((resolve) => {
    finishImport = resolve;
  });
  const inputs: Array<number | undefined> = [];
  return { ready, finishImport, inputs };
});

vi.mock("../screens/editor-screen.js", async (importOriginal) => {
  await screenModule.ready;
  const module =
    await importOriginal<typeof import("../screens/editor-screen.js")>();
  return {
    ...module,
    EditorScreen: (props: EditorScreenProps) => {
      screenModule.inputs.push(props.autofocusSince);
      return <module.EditorScreen {...props} />;
    },
  };
});
vi.mock("@monaco-editor/react", () => ({
  default: ({
    onMount,
  }: {
    onMount: (editor: unknown, monaco: unknown) => void;
  }) => {
    const ref = useRef<HTMLTextAreaElement>(null);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Monaco mounts once and retains the registered focus listener.
    useEffect(() => {
      const textarea = ref.current;
      if (!textarea) throw new Error("Monaco did not mount");
      onMount(
        {
          addCommand() {},
          onDidChangeCursorSelection() {},
          onDidFocusEditorText(listener: () => void) {
            textarea.addEventListener("focus", listener);
          },
          focus: () => textarea.focus(),
          getSelection: () => null,
          getModel: () => null,
        },
        { KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 1 } },
      );
    }, []);
    return <textarea ref={ref} data-testid="editor" />;
  },
}));
vi.mock("./file-inspector.js", () => ({ FileInspector: () => null }));
vi.mock("../lib/theme.js", () => ({
  useTheme: () => null,
  themeStyle: () => ({}),
}));
vi.mock("../lib/monaco-setup.js", () => ({ useMonacoTheme: () => "dark" }));
vi.mock("../lib/local-project-files.js", () => ({
  localEditorPath: async (_projectId: string, path: string) => path,
}));
vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    editorFileRead: async () => ({ content: "Plan" }),
    onGitChanged: () => () => {},
  },
}));

function mountPane() {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const render = () =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <EditorPane
            projectId="p1"
            active
            filePath="plan.txt"
            onFindFile={() => {}}
            onDirtyChange={() => {}}
          />
        </QueryClientProvider>,
      ),
    );
  const editor = () =>
    node.querySelector<HTMLTextAreaElement>("[data-testid=editor]");
  const settle = () =>
    vi.waitFor(async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(editor()).not.toBeNull();
    });
  const close = () => {
    act(() => root.unmount());
    client.clear();
    node.remove();
  };
  return { render, editor, settle, close };
}

it("retains opening ownership outside Suspense while a cold screen import and unrelated renders finish", async () => {
  const pane = mountPane();
  const inputs = personInputCount();
  const menu = document.createElement("button");
  menu.setAttribute("role", "menuitem");
  document.body.append(menu);
  try {
    await pane.render();
    expect(pane.editor()).toBeNull();
    notePersonInput();
    menu.focus();
    // The app can render fresh callbacks while the module is still loading.
    await pane.render();
    expect(pane.editor()).toBeNull();
    await act(async () => {
      screenModule.finishImport();
      await vi.dynamicImportSettled();
    });
    await pane.settle();
    expect(document.activeElement).toBe(menu);
    expect(screenModule.inputs.length).toBeGreaterThan(0);
    expect(screenModule.inputs.every((count) => count === inputs)).toBe(true);
  } finally {
    pane.close();
    menu.remove();
  }
});

it("lets an ordinarily opened editor take focus after the screen module is loaded", async () => {
  const pane = mountPane();
  const inputs = personInputCount();
  try {
    await pane.render();
    await pane.settle();
    expect(document.activeElement).toBe(pane.editor());
    expect(screenModule.inputs.at(-1)).toBe(inputs);
  } finally {
    pane.close();
  }
});
