# 0224 — A voice conversation's agent can stop listening

- **Status:** Accepted
- **Date:** 2026-10-13
- **Amends:** 0216 (voice), 0133 (the eager tool surface)

## Context

Voice (0216) stays on until the person clicks the microphone again or says
"stop". An agent that hears "that's all for now", or a person's own
instruction to end a call after a briefing, could not turn it off: it kept
listening, and anything said nearby became the chat's next message. People
want to teach their agents when a voice conversation is over, in their own
instructions and skills, as they teach everything else.

## Decision

**Every chat's agent has `stop_listening`**, a workspace tool with no
parameters whose description says only what it does: voice stops
listening and turns off once this turn's replies are read aloud. It never
says when to call it; the person's instructions and skills do. Voice's
per-turn note (0216) is unchanged. In a chat voice is not on, the tool
answers that voice is not on and changes nothing.

**The microphone closes at once; the turn is still said.** The speech
worker stops hearing (`stop-listening`: no detection, no push to talk, and
nothing still being recognized interrupts speech). The conversation drops
anything heard, reads the chat now, and once a read begun after the call
shows the turn over, every reply of it has gone to speech. Voice turns off
when those replies have been said. A goodbye written before or after the
call is heard; the microphone shows thinking or speaking meanwhile, never
listening. While voice is ending, its own microphone turns it off at once,
and another microphone, push to talk or learning a voice starts over, as
from off.

**It is eager** (0133): a voice conversation needs it at once, without a
discovery round trip in the middle of speech. Its schema costs about 250
bytes.

Considered: offering the tool only while voice is on. Tool lists are fixed
for a chat's warm harness and its prompt cache, so it would cost a cold
turn each time voice started or stopped. Turning voice off at the call
would cut off the agent's last words.

## Consequences

People steer when voice ends in their agents' instructions. The tool is in
every chat, voice or not, as one short line. An agent that calls it early
in a long turn keeps voice on, not listening, until that turn has been
said.
