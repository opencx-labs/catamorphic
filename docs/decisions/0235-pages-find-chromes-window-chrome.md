# 0235 — Pages find Chrome's `window.chrome`; a daily check watches Google's sign-in

- **Status:** Accepted
- **Date:** 2026-10-16
- **Amends:** [0150](0150-site-settings.md) (its 2026-10-09 cause), [0203](0203-work-runs-chrome-extensions-from-the-web-store.md) (what the browsing session's preload does in web pages)

## Context

Google's sign-in in a Work tab answered "Couldn't sign you in. This browser
or app may not be secure" on Electron 45 (Chromium 156) as it had on
Electron 44, so 0150's 2026-10-09 cause, the engine version, was wrong. That
move was never checked against the sign-in itself.

A stand-alone Electron harness carrying Work's identity code, each part
switched on or off, took the sign-in's first step with made-up addresses.
Google decides there, before it looks the account up: a browser past the
gate gets "Couldn't find this account", a refused one `/signin/rejected`.
Work's identity was refused every time, on Chromium 156 and 152, and
admitted once `window.chrome.app` was present, on both. A Chrome user agent
alone was refused; client hints on page loads, `chrome.csi`,
`chrome.loadTimes` and a Firefox user agent each changed nothing; plain
Electron, which names itself, was admitted. A browser that says it is
Chrome must have `chrome.app`. Chrome's comes from Chrome's own layer,
which Electron does not include, so Electron's `window.chrome` is empty.

## Decision

**Web pages get Chrome's `window.chrome`.** The browsing session's preload
installs `loadTimes`, `csi` and `app` in the main world of every web page:
a tab's top frame, a popup, and a tab's embedded frames, which also get
Chrome's client-hint brands now (`preload/chrome-object.ts`). It matches
Chrome 154, read from Chrome itself: member order, values and JSON, the
`TypeError`s Chrome's bindings throw for arguments they don't take,
`installState` answering after the call, which functions construct, and
that they read as native code (each sits behind a Proxy). Timing comes from
the page's navigation entry, read through functions kept before the page's
scripts run, and never throws. Members already there stay; extension pages
and workers are untouched.

**A live check watches the gate.** `e2e/google-sign-in.e2e.ts` takes the
first sign-in step in a Work tab with a made-up address, only with
`CATAMORPHIC_EXTERNAL_INTEGRATIONS=1`; it never enters a password. Real
Chrome on the same host, where there is one, takes the step too: when
Google refuses both, the network is refused and the test is skipped, not
failed. `.github/workflows/google-sign-in.yml` runs it daily on macOS and on
pull requests that change what pages see of Work or how the check runs. It
requires the verdicts file each run writes, so a check that skipped for
want of authority fails, and a failed daily run opens or adds to an issue.

Rejected: dropping the disguise for Google's sign-in (a per-site user agent,
as some Electron browsers do). Plain Electron passes today, but a site that
sees Electron elsewhere still treats Work as an embedded browser, and
Google has blocked identical engines by name before.

## Consequences

- The Electron 45 beta pin is no longer needed for sign-in; it stays for the
  changes that landed with it (TODO.md). Gmail's unsupported-browser notice
  (0150, Electron 44) was not re-measured.
- Script cannot match Chrome's bindings exactly: the app methods read as
  `function () { [native code] }`, without Chrome's names, and a frame a
  script creates (`about:blank`) keeps Electron's empty `window.chrome`.
  Google's first sign-in step checks neither today (TODO.md).
- `csi().pageT` keeps the page's 100µs timer resolution, and `firstPaintTime`
  comes from the `first-paint` entry, a few milliseconds from Chrome's.
- Only the first step is checked; a full sign-in, through password and
  2FA, is checked by hand.
- The live check depends on Google's English wording (it asks for `hl=en`)
  and treats Google's CAPTCHA as past the gate: in the runs above, a
  refused browser was refused outright even while Google asked others for
  one.
