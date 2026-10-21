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

const visible = (element: HTMLElement) =>
  !element.closest("[inert]") &&
  element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });

/**
 * What Find (Cmd+F) opens outside a page: a search field marked for it,
 * else any search in the content in front, so a screen that can be
 * searched answers the key without wiring it. A search field comes before
 * a button that opens one.
 */
export function findSearchTarget(): HTMLElement | undefined {
  const marked = findSearchInput("find");
  if (marked) return marked;
  const content = document.querySelector<HTMLElement>(".workspace-content");
  if (!content) return undefined;
  const first = (selector: string) =>
    [...content.querySelectorAll<HTMLElement>(selector)].find(visible);
  return (
    first(
      'input[type="search"], [role="searchbox"], input[aria-label^="Search" i], input[placeholder^="Search" i], input[placeholder^="Filter" i]',
    ) ?? first('[data-search-trigger], button[aria-label^="Search" i]')
  );
}

/** Go to a search: a field takes the keys, a button opens its search. */
export function activateSearch(target: HTMLElement): void {
  if (target instanceof HTMLInputElement) {
    target.focus();
    target.select();
  } else target.click();
}
