/**
 * Chat replies are Markdown written for reading. Spoken, the syntax is
 * noise: code is unspeakable, URLs are long, list markers and emphasis
 * mean nothing aloud. These functions turn a reply into the sentences
 * worth saying, and recognize the person's own words from an echo of them.
 */

const FENCE = /```[\s\S]*?(```|$)/g;

/** Markdown → plain spoken prose. Code blocks become one short mention. */
export function speakableText(markdown: string): string {
  let text = markdown.replace(/\r\n?/g, "\n");
  let hadCode = false;
  text = text.replace(FENCE, () => {
    hadCode = true;
    return "\n";
  });
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    // Tables and rules read as punctuation.
    .filter(
      (line) => line && !/^\|/.test(line) && !/^([-*_]\s*){3,}$/.test(line),
    )
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, "")
        .replace(/^>\s?/, "")
        .replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, ""),
    )
    .map((line) => (/[.!?:;,]$/.test(line) ? line : `${line}.`));
  const prose = lines
    .join(" ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<?https?:\/\/[^\s>)]+>?/g, "a link")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!hadCode) return prose;
  const mention = "The code is in the chat.";
  return prose ? `${prose} ${mention}` : mention;
}

const FILLERS = new Set(["uh", "um", "hmm", "mm", "mhm", "ah", "oh", "er"]);

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

/** A transcript worth sending: words beyond hesitation sounds. */
export function meaningfulUtterance(text: string): boolean {
  return words(text).some((word) => !FILLERS.has(word));
}

/**
 * Words compared by their stem: recognition of the agent's own voice
 * often drops or adds an ending ("payments" heard as "payment").
 */
function stem(word: string): string {
  return word.length > 3 ? word.replace(/('s|ing|ed|es|s)$/, "") : word;
}

/** Fewer words are the person's: short commands ("stop", "wait"). */
const ECHO_MIN_WORDS = 3;

/**
 * Whether a transcript is the agent hearing itself through the speakers:
 * a few words at least, nearly all of them from what it just said.
 */
export function isEcho(transcript: string, recentlySpoken: string): boolean {
  const heard = words(transcript).map(stem);
  if (heard.length < ECHO_MIN_WORDS) return false;
  const said = new Set(words(recentlySpoken).map(stem));
  const matched = heard.filter((word) => said.has(word)).length;
  return matched / heard.length >= 0.8;
}

/** A short spoken command to stop the agent, not a message for it. */
export function isStopCommand(transcript: string): boolean {
  const said = words(transcript).join(" ");
  return /^((alright|all right|okay|ok|hey|no|um|uh|so)\s)*(please\s)?(stop|cancel|never ?mind|be quiet|quiet|shut up|hold on|wait)(\s(it|that|talking|now|there|please|for now))*$/.test(
    said,
  );
}
