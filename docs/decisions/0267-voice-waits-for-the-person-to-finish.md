# 0267 — Voice waits for the person to finish

- **Status:** Accepted
- **Date:** 2026-10-20
- **Amends:** 0216 (voice), 0265 (voice yields to the person)

## Context

Two things made the agent talk over the person. Half a second of silence
ended their turn, so a pause to think mid-sentence sent what they had said
so far, played the cue, and let the agent answer while they went on. And a
reply that became ready while they were already talking played at once:
0265 pauses the agent only after the person's speech has run 0.3 s past
detection, about as loud as they speak and, once voice knows their voice,
like it, and whatever their words were then stopped the reply for good. So the
agent began over them, and when a pause did catch it, they never heard
what it had held.

## Decision

**0.8 seconds of silence ends a turn** (`main/voice/sherpa-speech.ts`,
`minSilenceDuration`, from 0.5). Turns still end soon after the person
stops; a pause to think no longer splits them.

**The agent never starts talking over the person** (`main/voice/engine.ts`).
When a stretch of speech began with the agent quiet and the agent then has
something to say, it holds from its first word (`waitForThePerson`): the
audio page is paused before anything plays. The stretch cannot be the
agent's own voice coming back, so there is no 0.3 s wait and no loudness
check. Someone else's voice, judged once a second tells (as 0265 does with
`speaking` false), lets it speak. When the stretch ends, its words go to
the agent as any utterance does, and what was held is then said: the
person did not interrupt the agent, so their words do not stop it. More
replies queue behind it.

Talking over the agent once it has started is unchanged: 0265's pause,
and the person's words stop it for good.

Considered: dropping the held reply when the person's words arrive, as a
barge-in does, which loses an answer they never heard; holding for any
detected speech before a second has told whose, without the release,
which lets a nearby talker hold the agent for as long as they talk.

## Consequences

- A reply that arrives while the person talks plays after them, then the
  answer to what they added; the agent may say something they have since
  moved past.
- A cough or noise that starts a stretch delays a reply until it ends
  (about the stretch plus 0.8 s).
- Every turn ends 0.3 s later than before.
