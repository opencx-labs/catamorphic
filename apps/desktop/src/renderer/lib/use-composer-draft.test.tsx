// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type {
  ChatDraft,
  ChatDraftUpdate,
} from "../../shared/desktop-workspace.js";
import { useComposerDraft } from "./use-composer-draft.js";

const api = vi.hoisted(() => ({
  dockDraftGet: vi.fn(),
  dockDraftSet: vi.fn(),
  onDockDraft: vi.fn(),
}));
vi.mock("./desktop-api.js", () => ({ desktopApi: api }));

async function mount() {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  document.body.append(editor);
  let resolve = (_draft: ChatDraft | null) => {};
  const promise = new Promise<ChatDraft | null>((done) => {
    resolve = done;
  });
  const saved = {
    promise,
    resolve: (draft: ChatDraft | null) => resolve(draft),
  };
  api.dockDraftGet.mockReturnValue(promise);
  api.dockDraftSet.mockReset();
  let receive = (_update: ChatDraftUpdate) => {};
  api.onDockDraft.mockImplementation((listener) => {
    receive = listener;
    return () => {};
  });
  const restore = vi.fn((draft: ChatDraft) => {
    editor.replaceChildren(document.createTextNode(draft.message));
  });
  const composer = createRef<{
    snapshot(): ChatDraft;
    restore(draft: ChatDraft): void;
  }>();
  composer.current = {
    snapshot: () => ({ message: editor.textContent ?? "", attachments: [] }),
    restore,
  };
  let publish = () => {};
  const loaded = vi.fn();
  function View() {
    publish = useComposerDraft({ localId: "chat", composer, onLoaded: loaded });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<View />));
  return {
    editor,
    saved,
    restore,
    loaded,
    publish: () => publish(),
    receive: (draft: ChatDraft) => receive({ localId: "chat", draft }),
    stop: async () => {
      await act(async () => root.unmount());
      editor.remove();
    },
  };
}

it("keeps newer local text and its caret when the initial draft read arrives late", async () => {
  const view = await mount();
  try {
    view.editor.textContent = "Newer typing";
    const text = view.editor.firstChild;
    if (!text) throw new Error("Missing draft text");
    document.getSelection()?.setPosition(text, 5);
    view.publish();
    await act(async () =>
      view.saved.resolve({ message: "Older saved draft", attachments: [] }),
    );
    expect(view.restore).not.toHaveBeenCalled();
    expect(view.editor.textContent).toBe("Newer typing");
    expect(document.getSelection()?.anchorNode).toBe(text);
    expect(document.getSelection()?.anchorOffset).toBe(5);
    expect(api.dockDraftSet).toHaveBeenLastCalledWith("chat", {
      message: "Newer typing",
      attachments: [],
    });
    expect(view.loaded).toHaveBeenCalledWith(
      expect.objectContaining({ superseded: true }),
    );
  } finally {
    await view.stop();
  }
});

it("keeps a newer broadcast ahead of an older initial response without echoing it", async () => {
  const view = await mount();
  try {
    const draft = { message: "From the other window", attachments: [] };
    view.receive(draft);
    await act(async () =>
      view.saved.resolve({ message: "Old", attachments: [] }),
    );
    expect(view.restore).toHaveBeenCalledExactlyOnceWith(draft);
    expect(view.editor.textContent).toBe(draft.message);
    expect(api.dockDraftSet).not.toHaveBeenCalled();
  } finally {
    await view.stop();
  }
});

it("restores an untouched draft once and never rewrites the editor to acknowledge typing", async () => {
  const view = await mount();
  try {
    const draft = { message: "Saved", attachments: [] };
    await act(async () => view.saved.resolve(draft));
    view.editor.textContent = "Saved and edited";
    view.publish();
    view.publish();
    expect(view.restore).toHaveBeenCalledExactlyOnceWith(draft);
    expect(api.dockDraftSet).toHaveBeenCalledExactlyOnceWith("chat", {
      message: "Saved and edited",
      attachments: [],
    });
  } finally {
    await view.stop();
  }
});
