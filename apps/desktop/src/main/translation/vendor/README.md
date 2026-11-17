# Bergamot translator glue

`bergamot-translator.js` is Firefox's Emscripten glue for the Bergamot
translation engine, copied unmodified from Firefox's release branch:
`toolkit/components/translations/bergamot-translator/bergamot-translator.js`
(bergamot-translator `v0.6.0+eea6e5a8`, from
https://github.com/mozilla/translations). It is licensed under the Mozilla
Public License 2.0, stated in its header; it stays its own file.

SHA-256 `faff1ef6285b0d26f01787776fd49299dfb756ecb9688aa990c250e66797b47d`.

It loads the engine's WebAssembly, which is not in the repository: Work
downloads it on first use, pinned by `engine` in `../catalog.json` (ADR 0320).
The glue and the engine must share a major version. When Firefox moves to a
new one, replace this file with its release copy and set `ENGINE_MAJOR` and
`MODEL_MAJOR` in `scripts/translation-catalog.ts` to match Firefox's
`BERGAMOT_MAJOR_VERSION` and `LANGUAGE_MODEL_MAJOR_VERSION_MAX`, then
regenerate the catalog.
