# macOS voice keys helper

`bin/voice-keys` is a prebuilt universal arm64/x86_64 executable (about 140
KiB), minimum macOS 11. It links only system Foundation, AppKit,
ApplicationServices and Carbon. Normal install, dev, build, test, and package commands
**do not compile it**. Only macOS packages copy it into
`Contents/MacOS/voice-keys`.

It is voice's shortcuts in every app, tapped or held, and dictation typed into
the app in front (ADR 0236). Without it, Work's own windows read the shortcuts
themselves (`main/voice/voice-keys.ts`).

To update the helper, on a Mac with the Xcode command-line tools:

```sh
bash apps/desktop/native/voice-keys/build.sh
```

Keep the source, binary, and generated `manifest.json` together. Unit tests check
the source/binary SHA-256 pins so source edits cannot silently ship an old
helper. The development artifact has an ad-hoc signature; electron-builder's
macOS `binaries` list signs it with the release identity before notarization,
and `scripts/desktop-signature.ts` checks the signed package.

## Protocol and authorization

`--version` prints `work-voice-keys 1` and touches nothing. Without arguments
the helper refuses a terminal stdout, then reads one command per line on stdin
and writes one event per line on stdout:

| Command | Meaning |
| --- | --- |
| `bind <name> <keycode> <modifiers>` | A shortcut: a virtual key code and Cmd=1, Ctrl=2, Alt=4, Shift=8; a key code of `-1` unbinds the name |
| `dictate <stretch> <final 0\|1> <base64 UTF-8>` | A stretch of dictation's words so far, typed where the cursor is: each update deletes and retypes only the end that changed, and empty text takes back what showed. Once the person types or clicks in its field, or focus moves to another element or app, the stretch is theirs and nothing more is typed for it. Nothing is typed into a password field or while secure input is on |
| `send-watch <0\|1>` | Report `send` when Return goes down with no modifier |
| `front` | Report the app in front and its focused window's title, `front <base64 JSON>`: names, never the text in it |

Events are `ready`, `down <name>`, `up <name>`, `send`, `front <base64 JSON>`
and `untrusted`. A
shortcut's keys, their repeats and their release are swallowed, so the app in
front never acts on them; every other key passes through untouched and
unrecorded. `send` names no key and carries no text.

An event tap that can swallow keys needs Accessibility. macOS attributes the
helper to Work, so it asks for Work, once, the first time a voice shortcut is
used in Work; Settings, Voice offers "Allow…" afterwards. Without it the helper
writes `untrusted` and exits 4, and the shortcuts work only in Work's windows.
The helper exits when stdin closes, so it never outlives Work.

Text it types carries a marker in each event's source user data, so its own
typing is never read back as the person's keys.

The event tap runs on a thread of its own and only matches keys there, so
no key in any app waits on the helper. Asking apps where their focus is,
and typing, happen on the main thread; an app gets 0.25 s to answer. A
person's key stops a stretch's typing between two key events, and a click
in its field ends it at the next update; a click elsewhere, such as on
Work's floating microphone, does not. If macOS turns the tap off for a moment, or the shortcuts change
mid-hold, a held shortcut comes up; a shortcut's key stays swallowed until
it comes up, even after its modifier did.
