# 0144 - App-styled controls and default browser

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

Native OS select menus and browser-default checkboxes conflict with the desktop's
project and profile menus. Browser import and default-browser setup should fit
into onboarding without crowding the existing project actions.

## Decision

Style all desktop semantic selects and checkboxes through one host stylesheet.
Use Chromium's customizable select picker in the top layer, supported by the
desktop's pinned Electron runtime. Keep standard labels, keyboard navigation,
typeahead, form events and disabled states. Picker menus share the app's surface
tokens, density, selected checkmark and paired 150 ms motion. Escape dismisses a
picker before its containing dialog. Reduced motion removes these transitions.
Project/profile switchers may retain their richer resource actions; they follow
the same visual contract. Do not create per-feature native or custom alternatives.

Onboarding is a vertical group of optional browser setup actions above the
existing project actions. Default-browser setup is the same OS-backed action in
onboarding and Settings. Register HTTP and HTTPS in the packaged app and only
request their defaults after an explicit click. Read the actual OS state,
refresh it on focus, and never store a fake preference. Development/test
executables cannot become the default. Keep incoming web URLs pending until the
owning window and profile workspace can open every URL through the browser tab
primitive. Existing Catamorphic invitation links retain their own handling.

## Consequences

The desktop host owns control appearance, including installed registry components.
Framework consumers retain their own styling. The current control contract and
implementation are linked from the desktop agent instructions and interaction
skill. Default-browser behavior also requires packaged OS verification; isolated
tests must never change the developer's defaults.
