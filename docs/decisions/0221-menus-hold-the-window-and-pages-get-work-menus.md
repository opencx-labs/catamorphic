# 0221 — Menus hold the window, and pages get Work's menus

- **Status:** Accepted
- **Date:** 2026-10-12
- **Amends:** 0203 (extensions' context menu items), 0121 (the detached dock's native menus)

## Context

The app draws its own menus (sidebar rows, dock bubbles, downloads,
history, the voice button) and each consumer dismissed them its own way:
some listened for presses, Escape and window blur, two only for Escape.
None saw a press inside a web page or an app's frame, which run in their
own processes, so on macOS a sidebar menu stayed open over the page the
person had just clicked. Nothing tied a menu to the row it came from
either, so closing the sidebar (Cmd+B) left its menu floating over the
page. Menus opened at the pointer extended to its left, under the pointer
and over the row they belonged to.

A page's right-click went the other way: main built a native menu with
Work's four open actions for links, saved sign-ins for password fields and
nothing at all elsewhere. Selected text, text fields, images, email
addresses and the page itself had no menu, not even Copy and Paste.

## Decision

**One menu primitive owns dismissal.** `MenuPortal` (renderer
`components/menu.tsx`) lays a transparent shield over the window under an
open menu, as a native menu holds the screen: a press anywhere else (a
row, a page, an app's frame, the title bar) closes the menu and does
nothing else, except that a right-click opens the menu of what is under
it, as on macOS. It also closes on Escape, when focus or the window
leaves it, when a scroll carries its anchor away, and when its anchor
turns inert or hidden, which is how a sidebar closes and a tab panel
switches. Focus goes back to where it was when the menu opened. Callers
pass `onDismiss` and, for rows, the anchor; none keeps its own listeners.
A menu opens at the pointer extending right and down (flipping where the
window ends) or under the control that opened it.

**Menus are data, rules included.** `shared/menu.ts` is the one entry
shape (with separators) for menus the window draws and the detached dock's
native ones, replacing `DockMenuEntry`.

**A page's context menu is Work's.** Main reads the right-click and builds
the entries (`main/page-menu.ts`, Chrome's grouping): open a link in a new
tab, to the side or floating, copy or download it; send email or copy the
address; call or copy a number; open, download or copy an image or
video; copy, search or look up a selection; spelling suggestions and the
edit commands in text fields, with what cannot happen turned off and a
reason; back, forward, reload, copy the address, print and view source on
the page; saved sign-ins in password fields; extensions' items; Inspect
last. The workspace window draws it at the click, like every other menu,
and sends the pick back; main runs it against the page it was built for,
skipping page-bound actions if the page has moved on, and the page gets
its focus back. Sign-in popups, which have no workspace to draw in, and
extension popups and side panels, whose focus an in-window menu over them
would disturb, show the same entries as a native menu, without saved
sign-ins or extensions' items (those reach tabs only).

Alternatives: keeping native page menus, which look unlike every other
menu in the app, follow the OS theme instead of Work's, and can't be
driven or filmed by the isolated tests; forwarding page presses through
the page preload, which misses embedded frames and app frames; and closing
menus from each sidebar's open state, which every other anchor would need
again.

## Consequences

- A press outside a menu no longer also acts on what it lands on; it only
  closes the menu, as on macOS.
- Bookmarks edit their name, address and folder in one dialog in every
  scope (this project, pinned, library); folders rename. Store changes and
  removals take the scope (`BookmarkUpdate`, `BookmarkRemoval`), which
  also lets a pinned folder be removed.
- The extension toolbar's own menu stays native for now.

## Amendment (2026-10-13): every menu is the primitive, and popovers close the same way

Menus kept appearing that a click away did not close: the project card's
⋯ was a hand-rolled dropdown with no dismissal at all, and popovers that
aren't menus (the project and profile lists, the extensions and downloads
bubbles, a chat's surface groups) each wrote their own listeners and never
heard a press inside a web page. Now:

- **A menu is `MenuPortal`.** A file that renders `role="menu"`,
  `aria-haspopup="menu"` or an overflow icon must render `MenuPortal` (or
  open a native menu through `desktopApi`); design-lint fails anything else.
  A menu opened from a hover card holds that card open until it has closed.
- **A popover that isn't a menu uses `usePopoverDismiss`**
  (`renderer/lib/popover-dismiss.ts`): it closes on a press outside it, a
  press inside a page or app frame, the window losing focus, and Escape,
  ignoring presses on its own hover cards and menus. Design-lint ratchets
  window and document press listeners outside these primitives.
