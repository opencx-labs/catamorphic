# 0320 — Pages translate on the device

- **Status:** Accepted
- **Date:** 2026-11-15

## Context

Chrome 138 gives pages `Translator` and `LanguageDetector` (the Translator
and Language Detector APIs). Electron ships Blink's half of them, so Work's
tabs expose both classes, but the browser-process half lives in `//chrome`
and is absent: `LanguageDetector.availability()` reports `"unavailable"` and
`Translator.availability()` and `create()` never settle (issue #445). Sites
that feature-detect the classes, such as the OpenCX inbox's message
translation, conclude translation works and wait forever.

Chrome answers them with Google's translation library, closed source and
downloaded by Chrome's component updater; nothing of it is available to
another app. Google's other translators run in the cloud (Cloud
Translation, page text sent to Google, an API key and a bill) or only on
phones (ML Kit).

## Decision

Work installs its own `Translator` and `LanguageDetector` in every browsing
frame of a secure context, from the browsing session's preload, in place of
Blink's, shaped as Chrome's: `availability()`, `create()` with `monitor`
`downloadprogress` events and `signal`, `translate()`, `translateStreaming()`,
`detect()`, `measureInputUsage()`, `inputQuota` and `destroy()`, with
Chrome's error names. Main answers them on the device:

- **Translation** runs Firefox's Bergamot engine (Marian, WebAssembly) in a
  utility process, with Firefox's own glue vendored unmodified (MPL-2.0).
  Models are Firefox's release models, downloaded per language pair on
  first use from Mozilla's attachment CDN, as Chrome downloads its own.
  Every file, the engine included, is pinned by SHA-256 in a committed
  catalog (`scripts/translation-catalog.ts` regenerates it from the Remote
  Settings collections Firefox reads); Work never reads the collections at
  runtime. A pair without a direct model goes through English, as Firefox
  does. As in Chrome, `create()` downloads only for a frame with transient
  user activation.
- **Detection** runs Google's CLD3 (`cld3-asm`, bundled), Chromium's
  open-source detector before its current model, so it is available at
  once and offline.

The worker loads models on demand, keeps a few, and exits after five quiet
minutes, since WebAssembly memory never shrinks.

Removing the classes so sites fall back was the smallest fix, but leaves
translation broken in Work. Apple's Translation framework needs macOS 15
and a person installing languages in System Settings, so most pairs would
report `"unavailable"`. A cloud translator sends page text to a third
party.

## Consequences

Sites that use the APIs translate in Work, page text never leaves the
computer, and the first use of a pair downloads 11 to 85 MB. Quality and
coverage are Firefox's, not Chrome's: about 58 languages to and from
English, and small models sometimes repeat a short phrase. Updating models
or the engine is a reviewed catalog change; a new engine major version also
replaces the vendored glue. Extension pages and workers keep Blink's
unanswered classes for now.
