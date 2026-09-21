/**
 * What a guest page's `window.open` becomes.
 *
 * Links that merely want another tab (`target=_blank`, cmd-click) open as
 * workspace tabs. A scripted popup — `window.open` with window features,
 * which Chromium reports as the `new-window` disposition — must stay a real
 * child window: sign-in popups (Google Identity Services, most OAuth
 * providers, payment sheets) hand their result back through
 * `window.opener`, and a detached tab has none. Re-homing those as tabs
 * leaves a blank page and a sign-in that never completes.
 */
export type GuestWindowOpenAction = "popup" | "tab" | "deny";

export function guestWindowOpenAction(input: {
  url: string;
  disposition: string;
}): GuestWindowOpenAction {
  const web = /^https?:/i.test(input.url);
  if (input.disposition === "new-window") {
    // Popups commonly open blank and are navigated by their opener.
    return web || input.url === "" || input.url === "about:blank"
      ? "popup"
      : "deny";
  }
  return web ? "tab" : "deny";
}
