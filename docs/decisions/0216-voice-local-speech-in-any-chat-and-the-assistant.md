# 0216: Voice: local speech, in any chat, and the assistant

- **Status:** Proposed (experimental)
- **Date:** 2026-10-02

## Context

People want to talk to Work and hear it answer, the way OpenAI's realtime
voice works: a fast model holds the conversation while slower, smarter work
happens behind it, and the conversation stays responsive meanwhile. Work's
intelligence comes from the Claude Code and Codex subscriptions people
already have; those give no realtime audio API, and ChatGPT plan tokens
cover neither transcription nor realtime (OpenAI's "Sign in with ChatGPT",
2026-09-29, is Responses-only). Speech therefore has to run on the machine,
and the "smart layer" has to be ordinary chats.

## Decision

**Speech runs locally, on sherpa-onnx alone** (`sherpa-onnx-node`, an
N-API addon, no Electron rebuild), in the speech worker: Silero VAD and
Parakeet TDT 0.6B v2 int8 to listen (about 18x faster than real time on
an M3 Pro), Kokoro-82M v1.0 (Apache 2.0, full precision) to speak, in its
best-graded American voices: Heart and Bella, Michael and Fenrir. About
870 MB downloads the first time voice starts, each file verified against
a SHA-256 pin while it streams and moved into place in one rename; models
a newer catalog replaced are removed (`main/voice/models.ts`).

**A sentence at a time.** A reply is spoken once its text is finished.
Kokoro runs once per sentence (sherpa-onnx splits the text), about three
times faster than real time, and each sentence plays as soon as it is
made, scheduled right after the one before. That is the same audio as the
whole reply in one clip, but a long reply starts as soon as a short one,
in about a second. Kokoro's own pauses are kept (sherpa-onnx shrinks them
to a fifth by default, which ran clauses and sentences together), and
each sentence drops the silence a fresh run starts with, so a sentence
break is the model's own. Interrupting stops the sentences not yet made.
Speaking text while the model is still writing it is left out: voice
replies are a sentence or two.

How it got here: Kokoro, Pocket TTS and Supertonic 3 were tried first;
Supertonic drifted between speakers on long turns. Qwen3-TTS and then
Chatterbox Turbo (both through MLX in a Python runtime) sounded better in
auditions but in the app copied their voices unevenly, cut out at stream
joins and mid-sentence, and Chatterbox held over 13 GB until capped, so
the app was reset to the simplest pipeline that is reliably whole.

**Other voices are not the person's.** A microphone in a room hears more
than the person: a television, a colleague on a call, the agent's own
voice through the speakers. Chromium's noise suppression does nothing for
voices. Detection and recognition hear the microphone as recorded,
captured at 16 kHz so Chromium resamples it. Each finished utterance is
cleaned by DPDFNet (Apache 2.0, a DeepFilterNet descendant, about 11
times real time on one core) only to tell who spoke. Cleaning first cost
words: Parakeet misheard more in noise once cleaned (20 against 15 of
212), and detection on cleaned audio fired later on soft speech, cutting
first words and splitting sentences at pauses. Over fourteen VCTK
speakers, detection on cleaned audio kept 96.6% of the words at a soft
level and 95.2% at a very soft one; on the audio as recorded, with 0.8 s
kept from before detection fires, 100% at both. The person can teach
voice their voice: "Learn my voice" in the
microphone's menu speaks a prompt and learns a voice print (a WeSpeaker
ResNet34 embedding, Apache 2.0) from the next six seconds they speak,
never from the prompt. From then on an utterance whose voice is less than
0.65 alike (cosine) is ignored: it neither becomes a message nor stops the
agent. On clean English speech the same speaker scored 0.84 or more and
other people 0.59 on average; the margin is for another microphone and a
noisy room. Speech under 0.8 s is too little to check and always passes,
so "stop" always works. The voice print lives in the profile's prefs, and
"Forget my voice" clears it. True background voice cancellation (removing
a voice from the same audio) has no open model fit for this; the voice
print is the open substitute.

**Three processes, each doing one job.** A hidden audio page
(`renderer/voice.html`) owns the microphone (Chromium echo cancellation on)
and the speakers. Chromium cancels everything played on the output device,
so the agent's voice is the canceller's reference however it plays.
Speech goes straight to the output device from an AudioContext at
Kokoro's 24 kHz, never through a MediaStream: Chromium re-times
MediaStream playback against the output clock by resampling it between
0.9x and 1.1x, which shifted the voice's pitch partway through longer
replies. A speech worker (an Electron utility process)
runs the models and turn-taking (`main/voice/engine.ts`). A transferred
`MessagePort` joins the page to the worker, so audio never crosses the
main process. The main process owns the conversation.

**Turn-taking.** Listening never stops. When the person's words end
they are transcribed; words that are not an echo of what the agent just
said stop it if it is speaking, and become the next message. "Stop" and
its kin interrupt the turn instead of becoming a message. There is no
check while the person is still talking over it: transcribing the
overlap is the one step that could stop the agent on its own echo.

**Voice talks with ordinary chats.** One voice is live per profile, and
it talks with one chat at a time. Every chat's composer has a microphone
beside Send: talking there continues that chat's session with its own
agent, on any harness, and turning voice off carries the conversation on
in text. The dock's microphone talks with the assistant (below). Clicking
another microphone moves voice to that chat without reloading the models;
each agent speaks in its own voice (`prefs.agentVoices`, set in the
agent's settings or a microphone's menu), else the profile's default
(`prefs.voiceId`). Chats of a company project have no microphone: voice
runs against the desktop's own server.

**What voice tells agents is information, not rules.** While the person
talks with a chat by voice, each of its turns carries a context fragment
(ADR 0152, `main/voice/guidance.ts`): they are talking by voice, what they
say is speech recognition and can be misheard, each message is read aloud
as soon as it is finished and they may not be looking, Markdown and code
come across badly, a few words before longer work let them hear it is
under way, and turning voice off carries on in text. It reaches every
harness the same way (Claude Code's and Codex's turn context, the
built-in agent's system message) and never shows in the transcript. It
says what is going on and leaves how to speak to the agent, so the
person's own instructions for an agent (its persona leads the system
prompt) can shape how it talks. Every assistant text segment is its own
message, so the words an agent says before its tool calls are spoken
while it works.

**The assistant** is the agent behind the dock: the person comes to it to
get things done across their projects and to keep up with them. It is one
of the person's agents with the assistant's tools and a short description
of them (`ASSISTANT_INSTRUCTIONS`), in a chat of its own kept in the
dock's project (`prefs.assistantSession`). By default it is Work's built-in
assistant, `work-assistant:<agent id>`: the person's default agent, its
harness, login and tools, with no instructions of its own and the
harness's default model. The person can make any of their agents the
assistant instead (`prefs.voiceAssistant`), `assistant:<agent id>`, which
runs exactly as they configured it, persona and model included, with the
assistant's tools added: in Settings › Voice, the dock microphone's menu,
or the palette ("Change assistant…"); "Create agent…" there runs the agent
wizard and makes its agent the assistant. Another assistant gets a chat of
its own on its next start. The agent registry builds both variants from
the base agent's configuration; it does quick things itself, a web lookup
or a look at some files. Measured on Sonnet 5.5 at low effort through
Claude Code: small talk starts speaking in about two seconds; a look at
files says "Let me look" at about three seconds and answers at about
eight; a web lookup speaks at about four and answers at about nine. The
built-in assistant answers at its harness default's pace; an agent on a
faster model makes a quicker assistant.

**Bigger work goes to sessions.** Six tools of the assistant's
(`main/server/assistant-tools.ts`) take the place of Work's project-only
session tools (`spawn_subsession` and its kin): `start_session` hands work
to a child session, and `list_sessions`, `read_session`, `message_session`,
`follow_session` and `stop_session` reach the person's chats in every
project of the profile, the ones it started and the ones the person
started, never touching incognito chats. A child runs on the base agent
(the `work` delegation route), or on an agent the person names, one of
theirs or one the project commits (the `named` route): "have the reviewer
look at this PR". `start_session` wraps the request in a brief
(`assistantTaskBrief`): the relay may be partial, the assistant's chat is
there to read what was actually said, and the person is reachable through
it with `send_project_session_message`, starting with the session's title.
Results come back on their own (ADR 0133's delegation delivery), which
wakes the assistant to answer. When to hand off is the model's judgment.

**Notes from the sessions it follows.** The assistant follows the
sessions it starts, and any chat it is asked to with `follow_session`
(`main/server/session-notes.ts`): an assistant message the followed
session writes with more work after it in the same turn is a note (a
turn's last message is its result, which delegation delivers). Notes
written close together go as one system message, at most one per session
every fifteen seconds, which reaches the assistant's next turn as a steer;
it passes them on in its own words or keeps them to itself. The transcript
shows one quiet line ("Build: 2 updates").

**News while voice is off.** The assistant's wake-ups happen whether or
not voice is on: it answers like any chat, and the person is notified like
any chat. The profile remembers the last reply heard live
(`prefs.assistantHeardThrough`); while voice is off the main process
checks the assistant's chat every five seconds, a dot on the dock's
microphone shows unheard replies, and the next start says them first.

**Settings are prefs.** The assistant, the voices, the microphone, push to
talk, and whether microphones show in the dock (`voiceInDock`) and in
composers (`voiceInChats`) are profile prefs, whatever changes them
(Settings, a microphone's menu, the palette, the file); a live voice
follows them, and the status voice publishes says only what it is doing.

**The microphones.** The dock's sits next to the dock's collapse arrows,
on their inner side; a composer's is the same control at the size of Send.
A ring fills around it while the models download, turns while they are
unpacked and loaded, and it lights once it really listens. The dock's
menu opens the assistant's chat, picks the assistant and its voice, the
microphone and push to talk, keeps it in the dock or not, or resets the
assistant's chat; a composer's picks its agent's voice and can hide
composers' microphones. Out of the dock, the assistant's microphone still
shows while voice talks with it, and the arrows' menu always offers it
back; it grows in and shrinks out in place.

**Shortcuts.** "Talk to Work" (⌘⇧Space) turns voice off wherever it is
on, or on with the assistant, an action like any other: rebindable, in
the palette. In push to talk (⌥Space, per profile) voice hears only while
the keys are held: down stops the agent and starts listening, starting
voice where it last talked when it is off; up sends what was said at once, with no wait for silence and no
voice-print check, since the person said when they talked. The main
process reads the keys in `before-input-event` of every window and web
page, so they work wherever focus is. It never cancels them there:
Chromium would then drop the key's release too. The window's shortcut
dispatcher and a page's preload swallow them instead, and only while
push to talk is on, so ⌥Space types as usual otherwise.

Considered: a separate realtime talker model in the main process that
calls the chat as a tool (OpenAI's chat-supervisor pattern, LiveKit
Agents, Pipecat). Those frameworks are bound to their own transports or to
Python, and a second loop would duplicate what subsessions already do:
async work whose result returns to the conversation. Considered capturing
audio in the dock: the dock moves between windows when it detaches, which
would tear the stream down.

## Consequences

- Bluetooth earbuds drop to call-quality audio while their own microphone
  is in use, so the voice sounds far worse through them than it is; another
  microphone keeps them in full quality.
- Voice works offline apart from the model turns, and costs nothing
  beyond the person's existing subscription.
- Claude Code starts a CLI process per turn, so a voice turn waits for it
  (seconds); Codex keeps its app server warm and answers sooner. A local
  "heard you" chime and the microphone's working animation cover the gap.
- Listening is English only (Parakeet v2); Parakeet v3 covers 25 European
  languages with the same code; the voices are American English.
- Echo cancellation through laptop speakers needs real-world tuning;
  headphones avoid it. End-to-end tests script the speech
  (`CATAMORPHIC_E2E_FAKE_VOICE`); the real models run in an opt-in suite
  (`CATAMORPHIC_VOICE_MODELS_DIR`).
- A session's message to the assistant is recognized by its title
  prefix, an instruction, not a guarantee; the transcript records the
  author either way.
- A committed project agent as the project's default is not varied; the
  built-in assistant uses the profile's default agent then, and only the
  person's own agents can be the assistant.
- A chat knows the person talks by voice from the turn's context, not from
  its history: a turn that started before voice went on reads as text.
- Licenses the app's notices must carry before shipping: Kokoro (Apache
  2.0) and the speech models it and sherpa-onnx bundle (espeak-ng data,
  GPL).
