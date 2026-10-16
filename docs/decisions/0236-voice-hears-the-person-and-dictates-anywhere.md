# 0236 — Voice hears the person, dictates anywhere, and its keys tap or hold

- **Status:** Accepted
- **Date:** 2026-10-16
- **Amends:** 0216 (voice)

## Context

Voice (0216) answered the room. A television or a colleague across it was
transcribed and sent to the agent, cut the agent off mid-sentence, and ran
on into the person's own turn, which then waited twenty seconds for
detection to give up. Noise became words ("Yeah.", "Okay, so."). The voice
print helped only people who had taught it, and its model told voices
apart poorly. Push to talk's keys did nothing unless a separate switch was
on. People also want voice as a keyboard, in any app.

## Decision

**Voice hears the person: the nearest voice that keeps talking.** Measured
on a benchmark of real speech (LibriSpeech) and real rooms (DEMAND), a
person near the microphone whose loudness varies from one thing to the
next, and another person across a reverberant room
(`apps/desktop/scripts/voice-benchmark`), tuned in one place (`Hearing` in
`main/voice/engine.ts`):

- **Who speaks.** The voice print model is 3D-Speaker's ERes2Net (Apache
  2.0, 26 MB, VoxCeleb). Keeping 98% of the person's stretches of 1.5 s in
  a café, it let 2 to 8% of other people through, against 24 to 62% for
  WeSpeaker's ResNet34 it replaces; it needs no noise removal, so DPDFNet
  is gone. Voice learns the person from what they say, with no teaching:
  their first stretch long enough to tell, then stretches clearly theirs,
  or said with a key held. A stretch clearly their voice is theirs at any
  level; one merely like theirs must also be about as loud as they speak;
  any other is ignored, unless clearly louder once voice is sure of them,
  a nearer person who takes over. "Learn my voice" pins the print: then no
  one else takes over. Prints made by the old model are forgotten.
- **How near.** The microphone keeps the gain the system gives it:
  Chromium's automatic gain lifted a far voice to the person's level
  whenever they paused. Its noise suppression is off too: on the live
  path it cost about twice the words (40 against 19 over the same 22
  sentences), and the measures here hold for a room's noise as recorded.
  Windows 10 dB under the person's level (the 90th
  percentile of 32 ms windows) are silence to the detector, so a far voice
  neither starts speech nor draws out the person's turn; before they have
  said anything, the speech under way is the measure. Speech too short to
  tell whose must come within 8 dB, and within 4 dB to stop the agent.
- **Words, not noise.** Parakeet's mean token log probability is −0.03 for
  speech near or far and −0.8 for words it makes of noise; under −0.35 is
  dropped.
- Silero VAD v6.2 was measured and kept out: in this pipeline it split
  sentences and let more of the far talker through than v4. TEN VAD's
  license conditions rule it out. No open target-speaker or background
  voice model fits: small permissive ones need features or runtimes
  sherpa-onnx lacks (Hush), an enrollment model to export and host
  (FireRedChat's personal VAD), or carry licenses the app cannot ship.

**Nothing said is lost to loading.** The microphone opens as voice
starts; the speech worker keeps what it hears, and the presses that came
with it, in order, until the models can hear them (at most 30 s). Between
voices it rests with the models loaded for 15 minutes, and the audio page
with it, loaded, its microphone closed: the next voice only opens the
microphone, about 0.2 s after the press, against 0.35 s when the page
loaded each time.

**Every way in taps or holds.** Three shortcuts, rebindable: Dictate
(⌥Space), Talk to Work (⌘⇧Space) and Talk to this chat (unbound). A
microphone's click and press are the same. A tap turns voice on, listening
on its own, or off where it already is; held, voice hears while held and
sends at release, with no wait for silence and no check of whose voice it
is, and a voice started by holding goes off once idle. The push to talk
switch and key are gone. On macOS, once Work is allowed in Accessibility
(asked once, after the first shortcut used in Work; Settings after), a
small helper (`native/voice-keys`, prebuilt and pinned like the browser
keychain helper) watches the shortcuts in every app on an event tap and
swallows them, so the app in front never acts on them.

**Dictation is speech to text, anywhere.** Dictate writes what the person
says where their cursor is: a composer, any field of Work's, a web page's,
or, through the helper, the app in front. The words show as they are said
and settle in place as recognition firms up: in a chat's composer as muted
words with a pulsing dot, in other fields as plain words, in other apps
typed and retyped only where they changed. Once the person types, clicks
or moves elsewhere, what showed is theirs and the rest of that stretch is
not written. Turning dictation off first writes what they are still
saying. Sending what was dictated ends dictation that listens on its own:
Return in a single line, a form sent, or a longer text that leaves its
field as Return goes down (a composer); in other apps, any Return.
"Dictation only", in microphones' menus and Settings, makes a
microphone's click dictate instead of talk.

**Out of Work, the dock's microphone floats.** While voice is on and Work
is not in front, the same microphone floats at the bottom of the screen,
never taking focus, unless the dock is detached and floats there already.
In the dock it shows whenever voice talks to the assistant or dictates.

**An agent hears where the person is, not what they see.** While the
person talks with a chat by voice from another app, each of their turns
names that app and its window (0216's voice note, the helper's `front`):
what they say may be meant for there, words to write or a change to what
is written, as much as a request. The agent decides, with its own tools to
look at the screen and type. Nothing in the field is read for it.

## Consequences

- A far talker only a few dB under the person, with a voice like theirs,
  still gets through now and then; holding a key, or "Learn my voice",
  settles it.
- Speech much softer than the person's own, too short to tell whose, is
  not heard; turning voice off and on again forgets them.
- Words said before the microphone opens are not heard: a word at most
  once voice is warm, more on the first start after launch or a long rest,
  when opening the microphone takes most of a second.
- A colleague who leans in, clearly louder and for long enough, becomes
  the person until the person speaks up again or holds a key.
- The shortcuts in other apps are macOS only, need Accessibility, and
  swallow their keys there: choose keys other apps do not need.
- Dictation types into other apps with synthesized key events, a stretch
  at a time, and never into a password field or while secure input is on.
- In other apps Return cannot be told from a new line: it ends dictation
  that listens on its own either way.
- Work's code editor keeps its own text: dictation writes nothing there.
