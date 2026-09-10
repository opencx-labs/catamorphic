import type { ComponentProps } from "react";
import type { ActionId } from "../../shared/actions.js";
import { formatBinding, useKeybindings } from "../lib/keybindings.js";
import { SearchInput } from "./search-input.js";

export function ActionSearchInput({
  action,
  ...props
}: ComponentProps<typeof SearchInput> & { action: ActionId }) {
  const bindings = useKeybindings();
  return (
    <SearchInput
      {...props}
      data-search-action={action}
      shortcut={formatBinding(bindings[action]) || "Unbound"}
    />
  );
}

export function findSearchInput(action: string): HTMLInputElement | undefined {
  const inputs = [
    ...document.querySelectorAll<HTMLInputElement>(
      `input[data-search-action="${action}"]`,
    ),
  ].filter(
    (input) =>
      !input.closest("[inert]") &&
      input.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
  );
  return (
    inputs.find((input) => input.closest(".workspace-content")) ?? inputs[0]
  );
}
