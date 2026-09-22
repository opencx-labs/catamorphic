# 0151: Browser password manager

- **Status:** Accepted
- **Date:** 2026-09-23
- **Builds on:** 0150 (site settings)

## Context

Browser tabs had a KDBX vault per profile, but using it felt broken.
The offer to save appeared on any click in a form, so a wrong password
got offered too. It disappeared when a sign-in redirected to another
subdomain. Single-page sign-ins that used plain buttons were never seen.
Filling was a bar across the top of the page rather than suggestions
under the field. New accounts had no strong-password help, and a login
could not carry a note. People expect Chrome's password manager, so that
is the bar.

## Decision

**Offer only a sign-in that worked.** The guest preload reports what a
form submitted and every change in the page's password forms. Main
(`login-capture.ts`) holds the submission until it has evidence. If the
next page has no password form, or the form leaves in place, it offers
to save. If the same site loads its password form again, the sign-in
failed and nothing is offered. An email-first step's username carries
into the password step. The vault compares the submission with what it
holds without revealing anything, so it offers **Save**, **Update**, or
nothing when the password is unchanged.

**Suggestions live under the field.** Clicking a username or password
field reports its position; the host draws the list over the page (the
webview composites into the renderer, so host overlays stack on pages).
The page keeps focus and forwards the keys the list owns: arrows,
Escape, and Enter only when a row is highlighted, so Enter still
submits. Main fills the chosen login, so passwords never pass through
the renderer.

**Generated passwords save themselves.** A new-password field (by
`autocomplete`, form shape, or naming) offers a 15-character password
built without look-alike characters. Main keeps the suggestion and fills
it into the new and confirm fields. When that form goes out, main saves
it at once and the tab shows **Password saved**. **Update** on that card
opens the editor for the username and note.

**One card, one editor, one page.** The save, update and saved states
share one non-modal card in the page's top-right corner, where Chrome's
key bubble opens. It never takes focus, and the site's own dialogs
remain centered. Adding and editing use one `PasswordEditor` modal: site,
username, password with reveal and generate, and a note. Passwords are a
workspace page (tab kind `passwords`), like Sites, opened from the
palette, profile settings and "Manage passwords". It lists logins and
the sites set to "Never for this site".

**Storage stays KDBX.** Notes use the standard `Notes` field, stored as
a protected value. Listings report only whether a note exists; its text
comes with `reveal`, behind the same device authentication as the
password. The "never save" origins live in the database's custom meta
data, so they travel with the vault.

Alternatives considered: offering on submit, as before (it offers failed
passwords); a centered modal for the save question (it interrupts a
sign-in that is still loading); and saving generated passwords when
suggested rather than on submit (it saves passwords for forms the user
abandons).

## Consequences

- Detection is heuristic, like Chrome's. A site that keeps a password
  form on the page it lands on after a successful sign-in gets no offer.
  Such logins can still be added from the Passwords page.
- Only the top frame is covered. Sign-in forms inside iframes neither
  report nor fill.
- Unpackaged development builds driven over CDP set
  `CATAMORPHIC_DEV_NO_SYSTEM_PROMPTS=1`. They then use Chromium's mock
  keychain and skip Touch ID, because nobody can answer those system
  sheets in an unattended session. Packaged builds ignore it.
