# 0311: Native macOS speech and push to talk

- **Status:** Accepted
- **Date:** 2026-11-10
- **Amends:** 0216, 0236, 0265, 0268, 0297
- **Supersedes:** 0267 and automatic listening, speaker identification and tap-to-toggle in the earlier voice decisions

## Context

The person requested native macOS speech recognition, local recognition on
Linux, and push to talk alone. Silence detection, speaker embeddings, voice
learning and automatic interruption exist to decide when and whom to hear.
A held microphone or shortcut already supplies that intent.

## Decision

Every platform captures only while a microphone or shortcut is held. Release
closes physical inputs immediately and transcribes the buffered audio. Pauses
never submit a message. Long holds use bounded recognition chunks but send one
agent message on release. Native macOS recognition streams provisional words while
held. A chat previews them in its composer, preserving the typed draft; the preview
clears when voice sends. Dictation keeps its final words in the field instead.
Linux retains release-time recognition. The audio page and worklet prepare before
a press without opening a microphone; first captured audio drives listening feedback.
Pressing interrupts playback; replies arriving during a hold queue until release.
Remove automatic turn detection, voiceprints, learning controls and tap toggles.
Silence never aborts a hold: device errors come from the capture API or an ended
track. Once recognition, the agent turn and playback finish, the microphone
settles immediately; there is no timed active/listening state after a reply.

On macOS, a small universal native helper uses Apple's Speech framework:
SpeechAnalyzer with SpeechTranscriber on supported macOS 26 hardware/locales,
otherwise SFSpeechRecognizer. Apple manages any language assets. Prefer on-device
recognition in the older API; it can use Apple's servers when unavailable.
Keep macOS 13 as the desktop minimum. Ship and verify the helper through the
existing native helper packaging/signature mechanism. It receives mono PCM from
the existing audio page and never opens a second microphone or writes audio files.

Linux retains Parakeet on sherpa-onnx. Kokoro reply synthesis, the speech worker,
audio page, chat routing and accessibility shortcuts stay shared. The macOS
catalog contains only Kokoro; no Work-managed recognition, activity or speaker
model is downloaded or loaded. Native dictation skips the reply voice download too.
Recognition cancellation and helper lifetimes
follow the owning voice so stale work cannot affect another conversation.

## Consequences

Voice has one input mode. A release before 250 ms discards the capture and shows
the standard tooltip asking the person to hold, with their configured shortcut.
Capture still starts on press, without waiting for that threshold. A press
released before its chat finishes starting never opens the microphone later. macOS speech
availability and language support follow Apple; the older recognizer can require
network access and Speech Recognition permission. Native first-use asset setup
can delay the first transcription. Linux still downloads its pinned local STT.
Reply synthesis remains a separate local model on both platforms.
The local inference runtime is imported on macOS only when a reply needs synthesis.
Successful Apple permission/asset preparation is reused across holds; cancellation
still terminates every native helper, and an actual failure permits preparation again.
