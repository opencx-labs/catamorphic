/** Includes controls disabled by a fieldset and content retained for exit motion. */
export const canFocusFormControl = (element: HTMLElement): boolean =>
  !element.hidden &&
  !element.matches(":disabled") &&
  !element.closest("[inert], [hidden]");
