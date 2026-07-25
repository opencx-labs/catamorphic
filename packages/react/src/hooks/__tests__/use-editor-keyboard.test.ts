import { act } from "@testing-library/react";
import { useAtom } from "jotai";
import { describe, expect, it } from "vitest";
import { panelVisibilityAtom, rightPanelOpenAtom } from "../../atoms.js";
import { renderHookWithProviders } from "../../test/render.js";
import { useEditorKeyboard } from "../use-editor-keyboard.js";

function pressEscape() {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
}

describe("useEditorKeyboard", () => {
  it("closes the Runs pane first when Escape pressed", () => {
    const { result } = renderHookWithProviders(() => {
      useEditorKeyboard();
      const [panels, setPanels] = useAtom(panelVisibilityAtom);
      const [right, setRight] = useAtom(rightPanelOpenAtom);
      return { panels, setPanels, right, setRight };
    });

    act(() => {
      result.current.setPanels((current) => ({
        ...current,
        runsPanel: true,
      }));
      result.current.setRight(true);
    });
    expect(result.current.panels.runsPanel).toBe(true);
    expect(result.current.right).toBe(true);

    pressEscape();

    expect(result.current.panels.runsPanel).toBe(false);
    expect(result.current.right).toBe(true);
  });

  it("closes right panel if the Runs pane is already closed", () => {
    const { result } = renderHookWithProviders(() => {
      useEditorKeyboard();
      const [panels, setPanels] = useAtom(panelVisibilityAtom);
      const [right, setRight] = useAtom(rightPanelOpenAtom);
      return { panels, setPanels, right, setRight };
    });

    act(() => {
      result.current.setPanels((current) => ({
        ...current,
        runsPanel: false,
      }));
      result.current.setRight(true);
    });

    pressEscape();

    expect(result.current.right).toBe(false);
  });

  it("is a no-op when nothing is open", () => {
    const { result } = renderHookWithProviders(() => {
      useEditorKeyboard();
      const [panels] = useAtom(panelVisibilityAtom);
      const [right] = useAtom(rightPanelOpenAtom);
      return { panels, right };
    });

    pressEscape();

    expect(result.current.panels.runsPanel).toBe(false);
    expect(result.current.right).toBe(false);
  });
});
