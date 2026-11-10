# 0310: Native macOS speech and push to talk

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
agent message on release. Dictation inserts completed chunks and its final words.
Pressing interrupts playback; replies arriving during a hold queue until release.
Remove automatic turn detection, voiceprints, learning controls and tap toggles.

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
model is downloaded or loaded. Recognition cancellation and helper lifetimes
follow the owning voice so stale work cannot affect another conversation.

## Consequences

Voice has one input mode. A quick tap captures no sustained speech. macOS speech
availability and language support follow Apple; the older recognizer can require
network access and Speech Recognition permission. Native first-use asset setup
can delay the first transcription. Linux still downloads its pinned local STT.
Reply synthesis remains a separate local model on both platforms.
