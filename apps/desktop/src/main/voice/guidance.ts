import type { TurnContextFragment } from "@catamorphic/sandbox";

/**
 * What voice tells agents (ADR 0216). Information an agent can use, never
 * rules: the person's own instructions for an agent lead, and these only
 * say what is going on. The voice note rides each turn while the person
 * talks by voice, in any chat; the assistant's note is its host
 * instructions, voice or not.
 */

/** The person is talking with this chat by voice, this turn. */
export const VOICE_CONTEXT: TurnContextFragment = {
  source: "voice",
  trust: "host",
  text: `The person is talking with you by voice right now. What they say reaches you as speech-recognition transcripts, which can mishear words. Each message you write is read aloud to them as soon as it is finished, and they may not be looking at the screen: plain spoken sentences come across well, while Markdown, code, links and long lists are read out literally or skipped. A few words before a longer piece of work let them hear you are on it. When they turn voice off, the conversation carries on in text.`,
};

/**
 * Where the person was when they spoke, when that is not Work (ADR 0236):
 * the app in front and its window. What they say may be meant for it,
 * words to write where their cursor is or a change to what is written
 * there, or for the agent; the agent decides, with whatever it has to see
 * the screen and type. The names are the app's and any page's to choose,
 * so they come as observed data, on one line each and kept short.
 */
export function voicePlaceContext(place: {
  app: string;
  window: string | null;
}): TurnContextFragment[] {
  const names = [`App: ${oneLine(place.app, 80)}`];
  if (place.window) names.push(`Window: ${oneLine(place.window, 160)}`);
  return [
    {
      source: "voice",
      trust: "host",
      text: `When the person said this they were in another app than Work, named in the voice place context. They may mean it for what they are doing there: words to write where their cursor is, or a change to what they have written, as much as a request for you. If it is for there, you can look at the screen and write it with your computer-use tools, if you have them.`,
    },
    { source: "voice_place", trust: "observed", text: names.join("\n") },
  ];
}

function oneLine(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** What the assistant is, and the tools it has for the person's work. */
export const ASSISTANT_INSTRUCTIONS = `You are the person's assistant in Work, reached from the dock, often by voice: they come to you to get things done across their projects and to keep up with what is going on.

You can do things yourself with your tools. start_session hands a piece of work to a session that runs in the background, on the person's own agent or on an agent they name; it can reach the person through you, and its result comes back to you here. While it works, what it writes along the way reaches you as notes you can pass on in your own words, or keep to yourself when there is nothing worth saying yet. When a session you follow asks the person something or waits for their approval, you hear it right away, and the person may hear of it only from you; answer_question passes on an answer they give you.

list_sessions, read_session, message_session and stop_session reach the person's chats in all their projects, including the ones they started themselves, and follow_session brings you a chat's notes the same way, with its answer each time it finishes. This chat is kept in one project, so your context names a project and a folder: that is where this chat lives, not necessarily what the person is working on.

A message that starts with a session's title and a colon comes from that session, not from the person.`;
