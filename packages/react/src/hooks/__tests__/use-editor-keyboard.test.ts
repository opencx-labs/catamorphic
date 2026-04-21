import { act } from "@testing-library/react";
import { useAtom } from "jotai";
import { describe, expect, it } from "vitest";
import { historySidebarOpenAtom, rightPanelOpenAtom } from "../../atoms.js";
import { renderHookWithProviders } from "../../test/render.js";
import { useEditorKeyboard } from "../use-editor-keyboard.js";

function pressEscape() {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
}

describe("useEditorKeyboard", () => {
  it("closes history sidebar first when Escape pressed", () => {
    const { result } = renderHookWithProviders(() => {
      useEditorKeyboard();
      const [history, setHistory] = useAtom(historySidebarOpenAtom);
      const [right, setRight] = useAtom(rightPanelOpenAtom);
      return { history, setHistory, right, setRight };
    });

    act(() => {
      result.current.setHistory(true);
      result.current.setRight(true);
    });
    expect(result.current.history).toBe(true);
    expect(result.current.right).toBe(true);

    pressEscape();

    expect(result.current.history).toBe(false);
    expect(result.current.right).toBe(true);
  });

  it("closes right panel if history is already closed", () => {
    const { result } = renderHookWithProviders(() => {
      useEditorKeyboard();
      const [history, setHistory] = useAtom(historySidebarOpenAtom);
      const [right, setRight] = useAtom(rightPanelOpenAtom);
      return { history, setHistory, right, setRight };
    });

    act(() => {
      result.current.setHistory(false);
      result.current.setRight(true);
    });

    pressEscape();

    expect(result.current.right).toBe(false);
  });

  it("is a no-op when nothing is open", () => {
    const { result } = renderHookWithProviders(() => {
      useEditorKeyboard();
      const [history] = useAtom(historySidebarOpenAtom);
      const [right] = useAtom(rightPanelOpenAtom);
      return { history, right };
    });

    pressEscape();

    expect(result.current.history).toBe(false);
    expect(result.current.right).toBe(false);
  });
});
