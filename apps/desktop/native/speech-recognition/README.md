# macOS speech recognition helper

`bin/speech-recognition` is a prebuilt universal arm64/x86_64 executable,
minimum macOS 13. It links system Foundation, AVFoundation and Speech, plus
the Swift runtime shipped with macOS. Normal install, dev, build, test and
package commands do not compile it. Package it in `Contents/MacOS` and sign
it with the release identity, following the other desktop native helpers.

On macOS 26 or later, supported hardware and languages use Apple's
`SpeechAnalyzer` and `SpeechTranscriber`. Apple manages the shared on-device
language assets through `AssetInventory`. Unsupported hardware, unsupported
languages and older macOS use `SFSpeechRecognizer`. That fallback requests
Speech Recognition permission and requires on-device recognition where the
recognizer supports it; other languages use Apple's service and require a
network connection. Work stores no speech-to-text model or audio files.

Build on macOS with an SDK containing the macOS 26 Speech APIs:

```sh
bash apps/desktop/native/speech-recognition/build.sh
```

The build retains a macOS 13 deployment target for both architectures. The
macOS 26 calls are availability guarded. Keep the source, embedded
`Info.plist`, binary and generated `manifest.json` together. Unit tests check
the source, plist and binary SHA-256 pins. The development signature is ad hoc.
The app's Info.plist must also contain `NSSpeechRecognitionUsageDescription`
for the fallback's permission prompt.

## Protocol

`--version` prints `work-speech-recognition 1`, without using Speech services.
`--locale <identifier>` selects a language; the default is `Locale.current`.

`--prepare` prepares the selected Apple's language assets, or requests
permission and checks availability for the fallback. Apple may download its
language assets here. The voice worker prepares lazily before its first
transcription; reading a reply aloud never requests recognition assets. The
helper does not open the microphone; Work captures audio separately.

`--stream` accepts little-endian Float32 mono PCM at 16 kHz as it arrives.
It writes newline-delimited provisional results while stdin remains open:

```json
{"protocol":1,"type":"partial","text":"The words so far"}
```

Each partial replaces the preceding preview. EOF finalizes recognition and
returns the success shape below. On older Macs, OS recognition segments may
finish during a pause; the helper continues the held stream with another request.
Only Work's release finishes a turn. Live results report confidence as zero.
`NativeRecognition.start(onPartial)` buffers audio during Apple preparation;
`write(samples)` streams it and `finish()` sends EOF and returns the final text.

Without `--prepare` or `--stream`, stdin contains little-endian Float32 mono PCM at 16 kHz,
followed by EOF. Each process transcribes one stretch of up to 60 seconds.
Empty and silent audio returns empty text before any Speech service is used.
Transcription does not download assets. If the OS removed a language asset,
the caller must prepare again.

Success exits 0 and writes one JSON line:

```json
{"protocol":1,"ok":true,"text":"The words.","confidence":-0.1}
```

Preparation returns the same shape with empty text and zero confidence.
Confidence is the mean log of Apple's confidence values, weighted by text
length for SpeechTranscriber and by segment for SFSpeechRecognizer in batch mode. Missing
confidence attributes and empty text return zero. These values have Apple's
calibration and should not inherit thresholds tuned for a different model.

Failure exits 1 and writes one JSON line:

```json
{"protocol":1,"ok":false,"error":{"code":"speech_permission","message":"Allow Work in System Settings > Privacy & Security > Speech Recognition, then try dictating again."}}
```

The TypeScript wrapper bounds preparation to five minutes and transcription
to 90 seconds. Canceling it rejects pending calls and sends SIGTERM, followed
by SIGKILL after one second if needed. The same wrapper can prepare again for
the next voice; disposal permanently releases it. The helper also has its own deadline
and exits if its parent process disappears. No audio is written to disk.

## Verification

```sh
bun run --cwd apps/desktop test src/main/voice/native-recognition.test.ts
```

The focused suite uses fake processes for setup, results, timeouts and
cancellation, checks artifact hashes, and runs the real helper only for
`--version` and silent PCM on macOS. It requests no permissions or language
downloads. Release QA should exercise real microphone capture and the
fallback permission prompt in a signed Work app. The automated suite does
not cover those prompts.

Apple references: [SpeechAnalyzer](https://developer.apple.com/documentation/speech/speechanalyzer),
[SpeechTranscriber](https://developer.apple.com/documentation/speech/speechtranscriber),
[AssetInventory](https://developer.apple.com/documentation/speech/assetinventory),
[SFSpeechRecognizer](https://developer.apple.com/documentation/speech/sfspeechrecognizer),
[Speech permission](https://developer.apple.com/documentation/speech/asking-permission-to-use-speech-recognition).
