# 0265 — Voice yields to the person, and keeps what they saw as they spoke

- **Status:** Accepted
- **Date:** 2026-10-19
- **Amends:** 0216 (voice), 0236 (hearing the person)

## Context

Voice (0216) stopped the agent's speech only once the person's sentence
was over and recognized, so the agent talked on through all of it. A
"Yeah." or "Okay." heard while it spoke became a message and a turn of
its own. The assistant answered about the wrong project: its chat is kept
in one project, and each turn showed that project's window, so "this pull
request" meant the one open in another window. And a turn's screen was
read as the turn started, after the person finished talking, by when what
they had looked at often had changed.

## Decision

**Talking over the agent pauses it as the person starts** (`main/voice/engine.ts`).
Speech under way 0.3 s past detection, about as loud as the person
(`bargeInDb`) and, once voice knows their voice, a little like it so far
(`pauseAlike` 0.2; asked again at a second, then as the stretch will be
judged), pauses the agent's voice while it is heard: the audio page
suspends its output, so everything scheduled waits where it was. The
person's words then stop it for good and become the message; anything
else (its echo, noise, someone else) lets it carry on. A pause with
nothing left to hold, or a page that plays elsewhere, lets go. Holding a
key still stops it at once.

Measured on the speech benchmark, extended for this: the person talking
over the agent paused it 39 times in 40, a median 0.64 s after starting,
and their words stopped it every time. Its own voice 12 or 20 dB under
them never paused it. A talker 6 dB under them paused it 19 times in four
and a half minutes on loudness alone, 2 once voice asked whose voice it
was. Considered: stopping for good at the first sound, which a cough or
an echo cuts off with no way back; transcribing while the person talks,
which 0216 left out because the overlap is where the agent hears itself.
Pausing first is LiveKit's "false interruption" handling.

**"Yeah" while the agent talks is listening, not a turn.** A transcript of
acknowledgements alone ("yeah", "okay", "got it", "oh, okay";
`isAcknowledgement`) said while it talks neither stops it nor is sent.
"Yes", "no", anything longer, and anything said with a key held are heard
as before. Messages need words the recognizer is surer of (`sureOfWords`
-0.25, from -0.35), which cost the person nothing on the benchmark (-0.2
lost 2 things in 40); dictation keeps -0.35 (`sureOfDictation`), since it
writes what it hears for the person to fix.

**What the person says reaches the agent at its next step.** Voice sends
with `dispatch: "steer"` (ADR 0240) whatever the composer does; the
assistant's `message_session` and the brief of a session it starts steer
by default too (ADR 0250).

**The agent sees what was on screen as the person started speaking.** As
a stretch of speech starts, voice keeps a sight (`main/voice/sight.ts`):
the project in front of the Work window they are in (or picked in the
floating microphone's menu), Work's screen for the chat as a turn
describes it (ADR 0152), the app in front when not Work (0236), and a
picture: Work's window when Work is in front; the display they are on
from another app, when they already allowed Work to record the screen;
else none. Work never asks for that access. The words are paired with the
stretch they were said in. The turn their message goes to describes that
screen, with its age; `screen_when_spoken` loads the picture when the
agent wants it. A turn a typed message or a notification starts sees the
screen as it is. Sights stay in memory, the latest per chat for half an
hour; a picture the tool loads goes to the model like any tool result.

**The assistant is where the person is.** Its turns name the project
whose window the person is in, apart from where its chat is kept, show
that window, and no longer list its home project's chats as theirs. Its
tools that look or show (`workspace_overview`, `read_tab`, `open_surface`,
`point_at`) act there, where they were as they spoke this turn's message;
`workspace_overview` and `read_tab` take another project's name, and a
tab seen there is read there. What it drives itself stays with its chat,
whose turn hands it back: browser tabs it holds, its terminals, its own
chips. `screen_when_spoken` is eager for the assistant and discovered by
other chats, keeping their always-loaded tools within budget.

## Consequences

- A pause the person did not cause is a moment of silence, about the
  sound plus half a second. Before voice knows their voice, loudness
  alone decides.
- A "yeah" answering a question the agent is still asking is not heard.
- A message that reaches a turn already at work brings no screen in its
  context; the tool still has it.
- From another app without Screen Recording access, the agent gets the
  app's name and no picture; the tool says how to allow it. With access,
  each stretch of speech from another app captures the display.
- The benchmark (`apps/desktop/scripts/voice-benchmark`) measures pauses,
  echo and talkers over the agent.
