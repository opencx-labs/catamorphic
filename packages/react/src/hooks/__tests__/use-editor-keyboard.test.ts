import { act } from "@testing-library/react";
import { useAtom } from "jotai";
import { describe, expect, it } from "vitest";
import { selectedNodeIdAtom } from "../../atoms.js";
import { renderHookWithProviders } from "../../test/render.js";
import { useEditorKeyboard } from "../use-editor-keyboard.js";

function pressEscape(target: EventTarget = document) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
}

describe("useEditorKeyboard", () => {
  it("lets the host consume Escape before the selection clears", () => {
    let paneOpen = true;
    const { result } = renderHookWithProviders(() => {
      useEditorKeyboard({
        onEscape: () => {
          if (!paneOpen) return false;
          paneOpen = false;
          return true;
        },
      });
      return useAtom(selectedNodeIdAtom);
    });

    act(() => result.current[1]("step-1"));
    pressEscape();
    expect(paneOpen).toBe(false);
    expect(result.current[0]).toBe("step-1");

    pressEscape();
    expect(result.current[0]).toBeNull();
  });

  it("leaves Escape to text fields", () => {
    const { result } = renderHookWithProviders(() => {
      useEditorKeyboard();
      return useAtom(selectedNodeIdAtom);
    });
    const input = document.createElement("textarea");
    document.body.append(input);

    act(() => result.current[1]("step-1"));
    pressEscape(input);
    expect(result.current[0]).toBe("step-1");
    input.remove();
  });
});
