# 0297: Voice capture follows listening intent

- **Status:** Accepted (amends 0236, 0268)
- **Date:** 2026-10-29

## Context

Releasing push-to-talk left the microphone open while recognition and the reply
continued. Turning off dictation waited for recognition before releasing capture.
macOS's audio-lowering helper also owns an input, independently of Chromium.
The person requested that stopping listening release every input immediately.

## Decision

Main owns physical capture intent: an active voice that is not ending captures
only while hands-free or held. Apply that intent to both the audio page and the
native audio-lowering helper, including audio pages connected after a release.
Reuse the microphone's abortable closer and retain its playback port when capture
closes or reopens. Recognition of buffered audio remains eligible after capture
ends; stopping capture must not call the engine's terminal `stopListening`.

A released hold stays pending until the existing recognition promise settles for
all its pieces. Identify the release in its acknowledgement so an earlier hold
cannot start the idle timer while a later hold is still being transcribed.

## Consequences

Push-to-talk and dictation can finish transcribing and playing a reply with no
microphone open. Capture restarts on another hold without replacing playback.
Regression coverage must check physical tracks and delayed recognition, rather
than infer microphone ownership from the visible voice phase.
