# macOS voice quiet helper

`bin/voice-quiet` is a prebuilt universal arm64/x86_64 executable (about 140
KiB), minimum macOS 13. It links only system Foundation, AVFoundation and
CoreAudio. Normal install, dev, build, test, and package commands **do not
compile it**. Only macOS packages copy it into `Contents/MacOS/voice-quiet`.

It lowers other apps' audio while voice listens (ADR 0268): it runs macOS's
voice processing on the microphone voice listens with, and macOS lowers every
other sound as it does for a call. It hears nothing itself; Work's audio page
listens and transcribes. Without it, nothing is lowered
(`main/voice/voice-quiet.ts`).

To update the helper, on a Mac with the Xcode command-line tools:

```sh
bash apps/desktop/native/voice-quiet/build.sh
```

Keep the source, binary, and generated `manifest.json` together. Unit tests check
the source/binary SHA-256 pins so source edits cannot silently ship an old
helper. The development artifact has an ad-hoc signature; electron-builder's
macOS `binaries` list signs it with the release identity before notarization,
and `scripts/desktop-signature.ts` checks the signed package.

## Protocol

`--version` prints `work-voice-quiet 1` and opens nothing. Without arguments
the helper refuses a terminal stdout, then reads one command per line on stdin
and writes one event per line on stdout:

| Command | Meaning |
| --- | --- |
| `quiet <base64 UTF-8 label>` | Lower other audio, for the microphone with this label (Chromium's, with or without `Default - `) |
| `loud` | Let other audio back up |

Events are `ready`, `quiet`, `loud` and `unavailable <reason>`:

| Reason | Meaning |
| --- | --- |
| `microphone` | The label is not the system's input. Voice processing opens the system's input, and opening another, such as a Bluetooth headset's, would switch the headset to its call mode, so nothing is lowered |
| `voice-processing`, `start` | macOS refused voice processing or the engine |
| `changed` | The devices changed while it was lowered: audio is back up |
| `label` | The label was not valid base64 UTF-8 |

The helper exits when stdin closes, letting other audio back up, so it never
outlives Work. Automatic gain stays off: the microphone keeps the gain the
system gives it (ADR 0236). On macOS 14 and later the ducking level is Mid.
