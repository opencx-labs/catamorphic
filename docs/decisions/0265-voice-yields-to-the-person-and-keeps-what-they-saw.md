# 0265 — Voice yields to the person, and keeps what they saw as they spoke

- **Status:** Accepted
- **Date:** 2026-10-19
- **Amends:** 0216 (voice), 0236 (hearing the person)

## Context

Talking over the agent did not stop it: voice (0216) stopped the agent's
speech only once the person had finished their sentence and it was
recognized, so the agent talked on through everything they said. Noise
still became messages now and then ("Yeah.", "Okay.", a made-up word).
The assistant answered about the wrong project: its chat is kept in one
project, and each turn's screen was that project's window, so a person
asking about "this pull request" in one window heard about the pull
request open in another. And what a turn showed of the screen was taken
as the turn started, after the person had finished talking, by when what
they had looked at as they began often had changed.

## Decision

**Talking over the agent pauses it as the person starts** (`main/voice/engine.ts`).
Speech under way for 0.3 s past the detector's own quarter second, about
as loud as the person speaks (within `bargeInDb`) and, once voice knows
their voice, at least a little like it so far (`pauseAlike`, 0.2), while
the agent is heard, pauses its voice: the audio page suspends its
output's clock, so everything scheduled stays where it was. Not like it
yet, it is asked once more at a second. What the stretch turns out to be
decides the rest. The person's words stop the agent for good and become
the message, as before; anything else (its own voice coming back through
the speakers, noise, words made of noise, someone else) lets it carry on
where it paused. A stretch pauses the agent once; the speaking animation
follows the voice from where it carries on. Holding a key still stops it
at once.

Measured on the speech benchmark, extended for this: the person talking
over the agent paused it 39 times in 40, a median 0.64 s after they
started, and every time their words stopped it. The agent's own voice 12
or 20 dB under the person paused it never. A talker 6 dB under them, the
hardest case, paused it 19 times in four and a half minutes on loudness
alone; asking whose voice it is brought that to 2 (0.1: 9, 0.3: 1) at no
cost to the person. A tighter loudness margin cost the person instead
(0 dB: 4 pauses, the person 27 in 40), and waiting 0.5 s changed nothing
but the delay (0.83 s).

Considered: stopping for good at the first sound (OpenAI's and most
voice agents' default with server-side detection), which a cough or the
agent's own echo would cut off with no way back; transcribing while the
person talks, which 0216 left out because the overlap is where the agent
hears itself. Pausing first is LiveKit's "false interruption" handling:
the pause costs nothing when it was the person, and a moment's silence
when it was not.

**"Yeah" while the agent talks is listening, not a turn.** A transcript
that is only acknowledgements ("yeah", "okay", "right", "got it", "uh
huh"; `isAcknowledgement`), heard while the agent is speaking or paused,
neither stops it nor becomes a message: it carries on. Answers that carry
a decision ("yes", "no") and anything longer are heard as before, and so
is anything said with a key held. The room noise the benchmark plays
(a café, an office, a bus) already sent nothing; what reached people's
chats was a "Yeah." or "Okay." said or heard while the agent spoke, which
then started a turn of its own. Words the recognizer is less sure of are
dropped too: under a mean token log probability of -0.25 (`sureOfWords`,
from 0236's -0.35), which cost the person nothing on the benchmark;
-0.2 lost them 2 things in 40 over a far talker.

**What the person says reaches the agent at its next step.** Voice sends
with `dispatch: "steer"` (ADR 0240) whatever the chat's composer does, as
speaking to an agent at work would. The assistant's `message_session`
steers by default too (ADR 0250's default between agents), and the brief
of a session it starts says `steer`.

**The agent sees what was on screen as the person started speaking.**
When a stretch of speech starts (detected, or a key or microphone held),
voice keeps what the person sees (`main/voice/sight.ts`): the project in
front of the Work window they are in, Work's screen for the chat voice
talks with as a turn describes it (ADR 0152), the app in front when it is
not Work (its name and window's, ADR 0236), and a picture: the display
they are on when they already allowed Work to record the screen, else
Work's window when Work is in front, else none. The words they said are
paired with the stretch they said them in. The turn their message starts
describes that screen, saying how long ago it was, instead of the screen
as the turn starts; `screen_when_spoken` loads the picture when the agent
wants it, since it often adds nothing. Pictures stay in memory, the
latest per chat for half an hour, and reach a model only through the
tool. Work never asks for Screen Recording itself.

**The assistant is where the person is.** Its turns name the project
whose window the person is in (when they spoke, or now for typed turns)
apart from the project its chat is kept in, and show that window. Its
tools that look at or act in a window (`workspace_overview`, `read_tab`,
`open_surface`, `point_at`, the browser's) act there, wherever its chat
lives; `workspace_overview` and `read_tab` take another project's name to
look at its window, and what it then does with a tab seen there goes
there. Its own terminals stay with its chat, and its turns no longer list
its home project's chats as "this project". `screen_when_spoken` is
eager for the assistant and discovered by other chats: the always-loaded
tools stay within their budget.

## Consequences

- A pause the person did not cause (echo, a cough) is a moment of silence
  in the agent's voice, about as long as the sound plus half a second.
- Before voice knows the person's voice (the first long stretch they say
  teaches it), loudness alone decides whether to pause.
- A "yeah" meant as an answer to a question the agent is still asking is
  not heard: said once it has finished, it is.
- Without Screen Recording access, talking from another app gives the
  agent the app's name and no picture; the tool says how to allow it.
- Each stretch of speech takes a picture as it starts (reused within a
  second): a window capture, or a display capture with access.
- The voice benchmark (`apps/desktop/scripts/voice-benchmark`) measures
  how soon the agent pauses for the person, and how often echo or another
  talker pauses it.
