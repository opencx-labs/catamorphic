# 0268 — Voice lowers other apps' audio while it listens, and reads any reply aloud

- **Status:** Accepted
- **Date:** 2026-10-20
- **Amends:** 0216 (voice), 0236 (hearing the person)

## Context

Music or a video playing in another app reached the microphone and the
agent heard it: Chromium's echo cancellation removes what Work plays, not
what Spotify or Chrome play. And a reply could be heard only while talking
with its chat by voice; a person reading along had no way to hear one.

## Decision

**While voice listens, hears the person or waits on the agent, other apps'
audio is lowered** (`main/voice/voice-quiet.ts`, `native/voice-quiet`). On
macOS a small helper runs the system's voice processing on the microphone
voice listens with, and macOS lowers every other sound as it does for a
call (ducking level Mid on macOS 14 and later, automatic gain off, as 0236
keeps it). The helper hears nothing; Work's audio page still listens. It
lets the audio back up while the agent speaks, since voice processing
lowers Work's own voice too, and goes when voice turns off; it exits when
its stdin closes. The audio page reports its microphone's label; the
helper runs only when that is the system's input, because voice processing
opens the system's input and opening another (a Bluetooth headset's)
would switch the headset to its call mode. A chosen microphone that is not
the system's lowers nothing. It ships like the voice keys helper:
prebuilt universal, pinned by SHA-256, signed with the release identity
and checked by `scripts/desktop-signature.ts`. Elsewhere nothing changes.

Considered: muting Work's own browser tabs, which echo cancellation
already removes; lowering each app's volume through the system mixer,
which macOS gives no public way to do; running voice's own capture through
voice processing, which brings its noise suppression and gain back into
what voice transcribes (0236 measured those costs).

**Any agent reply can be read aloud from a button beside Copy**, voice on
or off. The chat timeline takes `onReadAloud` and
`readingAloud` from its host and shows the button only when given them; the
desktop gives them, the phone app does not yet. With voice on, its voice
says the reply as it says one, in the voice it speaks in, and talking over
it stops it the same way. With voice off, the speech worker and audio page
voice uses say it in the reply's agent's voice, with the microphone left
closed (`VoicePortMessage.listen` false), then rest,
warm for the next voice; voice starting ends the reading first. Pressed
again, or for another reply, the reading stops. Voice status carries
`reading` (the reply, and whether it is still on its way), which the button
shows as a spinner, then a stop square, and keeps in view while it plays.

## Consequences

- The person tries the lowering by ear on their own machine: it cannot be
  measured in CI, which has no audio devices.
- With a microphone other than the system's, other audio stays as it is.
- The first read aloud on a machine downloads the speech models, as voice's
  first start does; the button shows a spinner until the reply plays.
