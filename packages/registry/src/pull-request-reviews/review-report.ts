/*
 * Pure helpers `postReviews` checks a review with before it posts: no IO,
 * so every boundary that calls them replays alike.
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/**
 * What the reviewer reports, once checked: its `review` result (ADR 0323),
 * which Work accepted against the schema in `.work/agents/reviewer.json`.
 */
export type WorkReview = {
  reviewedCommit: string;
  verdict: "COMMENT" | "REQUEST_CHANGES";
  score: number;
  summary: string;
  checkSummary: string;
  comments: Array<{
    path: string;
    line: number;
    side: "LEFT" | "RIGHT";
    body: string;
  }>;
  reply: { inReplyTo?: number; body: string } | null;
};

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Lines a review comment may sit on: `path:RIGHT:12` in the new file, `path:LEFT:9` in the old. */
export function diffLines(result: unknown): Set<string> {
  const lines = new Set<string>();
  for (const file of list(record(result).files).map(record)) {
    if (typeof file.path !== "string" || typeof file.patch !== "string")
      continue;
    let left = 0;
    let right = 0;
    for (const line of file.patch.split("\n")) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        left = Number(hunk[1]);
        right = Number(hunk[2]);
      } else if (line.startsWith("+"))
        lines.add(`${file.path}:RIGHT:${right++}`);
      else if (line.startsWith("-")) lines.add(`${file.path}:LEFT:${left++}`);
      else if (line.startsWith(" ")) {
        lines.add(`${file.path}:RIGHT:${right++}`);
        lines.add(`${file.path}:LEFT:${left++}`);
      }
    }
  }
  return lines;
}

/**
 * Report text is posted as the App: it mentions no one and hides nothing.
 * GitHub reads it as CommonMark with GitHub's extensions, and so does
 * this, with a maintained parser: its code blocks (suggestions included)
 * and code spans stay exactly as written, since GitHub renders neither
 * HTML nor mentions there. Everywhere else, every `<` that would open a
 * comment, a declaration such as `<!DOCTYPE …>` or `<![CDATA[`, a
 * processing instruction (`<?…?>`), or an HTML block that could swallow
 * a code fence (`<pre>`, `<script>`, `<style>`, `<textarea>`), all of
 * which GitHub hides, gets a zero-width space after it; "@name",
 * "@org/team" and an `@` written as an entity stop notifying the same
 * way; and a link reference definition (`[//]: # (…)`), which GitHub
 * shows nothing of, is escaped to show as text. Nothing is removed.
 *
 * Defusing can change how the rest reads (a comment that hid a fence no
 * longer does), so the result is read again until nothing changes; text
 * that keeps changing is defused whole, code included. Run it once on
 * the whole body GitHub gets, never on its parts one by one.
 */
export function publicationText(text: string): string {
  let current = text;
  for (let pass = 0; pass < 8; pass += 1) {
    const next = defuse(current, codeOf(current));
    if (next === current) return current;
    current = next;
  }
  for (;;) {
    const next = defuse(current, {
      code: [],
      definitions: definitionsOf(current),
    });
    if (next === current) return current;
    current = next;
  }
}

/**
 * A body to post with this recipe's `stamp` after it: the body defused,
 * and a code block it leaves open closed first, so the stamp is the HTML
 * comment GitHub hides and not text in the block.
 */
export function stampedBody(body: string, stamp: string): string {
  let text = publicationText(body);
  for (let pass = 0; pass < 2; pass += 1) {
    const stamped = `${text}\n\n${stamp}`;
    const at = text.length + 2;
    const open = codeOf(stamped).code.find(
      ([start, end]) => start < at && end > at,
    );
    if (!open) return stamped;
    const fence = /^[ \t>]*(`{3,}|~{3,})/.exec(stamped.slice(open[0]))?.[1];
    text = `${text}\n${fence ?? "```"}`;
  }
  return `${text}\n\n${stamp}`;
}

/** Where `text` is code as GitHub reads it, and where its link reference definitions start. */
function codeOf(text: string): {
  code: Array<[number, number]>;
  definitions: number[];
} {
  const code: Array<[number, number]> = [];
  const definitions: number[] = [];
  const visit = (node: MarkdownNode) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (node.type === "code" || node.type === "inlineCode") {
      code.push([start, end]);
      return;
    }
    if (node.type === "definition") definitions.push(start);
    for (const child of "children" in node ? node.children : []) visit(child);
  };
  visit(parsed(text));
  return { code: code.sort((left, right) => left[0] - right[0]), definitions };
}

function definitionsOf(text: string): number[] {
  return codeOf(text).definitions;
}

type MarkdownRoot = ReturnType<typeof fromMarkdown>;
type MarkdownNode = MarkdownRoot | MarkdownRoot["children"][number];

function parsed(text: string): MarkdownRoot {
  return fromMarkdown(text, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
}

/** `text` with everything but `code` defused, and its definitions escaped. */
function defuse(
  text: string,
  read: { code: Array<[number, number]>; definitions: number[] },
): string {
  // A definition's `[` gets a backslash before it, so it reads as text.
  const escapes = new Set(
    read.definitions
      .map((start) => text.indexOf("[", start))
      .filter((at) => at >= 0),
  );
  let out = "";
  let at = 0;
  const prose = (end: number) => {
    let segment = "";
    for (let index = at; index < end; index += 1) {
      if (escapes.has(index)) segment += "\\";
      segment += text[index];
    }
    out += segment
      .replace(/<(?=[!?]|(?:pre|script|style|textarea)\b)/gi, "<\u200b")
      .replace(/&(?:#0*64|#x0*40|commat);/gi, "@\u200b")
      .replace(/@(?=[A-Za-z0-9])/g, "@\u200b");
    at = end;
  };
  for (const [start, end] of read.code) {
    if (start < at) continue;
    prose(start);
    out += text.slice(start, end);
    at = end;
  }
  prose(text.length);
  return out;
}

/**
 * Text shaped like this recipe's stamp (see `marker` in reviews.ts), which
 * a retry finds by a raw search of GitHub bodies, code included.
 */
const STAMP_SHAPED = /<!--\s*work-review:/i;

/** Every string a value holds, at any depth. */
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (typeof value === "object" && value !== null)
    return Object.values(value).flatMap(stringsOf);
  return [];
}

/**
 * The turn's `review` result, checked field by field again: the sandbox
 * that submitted it is untrusted, and its schema is project code. A string
 * says why it cannot be used. Its text is kept as written: each body is
 * defused whole as it is posted (`publicationText`, `stampedBody`).
 */
export function checkWorkReview(value: unknown): WorkReview | string {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "the review is not a JSON object";
  if (JSON.stringify(value).length > 65536) return "the review is over 64 KB";
  const report = record(value);
  const fields = [
    "reviewedCommit",
    "verdict",
    "score",
    "summary",
    "checkSummary",
    "comments",
    "reply",
  ];
  const extra = Object.keys(report).find((key) => !fields.includes(key));
  if (extra) return "it has an unknown field";
  const { reviewedCommit, verdict, score, summary, checkSummary } = report;
  if (
    typeof reviewedCommit !== "string" ||
    !/^[0-9a-f]{40}$/.test(reviewedCommit)
  )
    return "reviewedCommit is not a full commit";
  if (verdict !== "COMMENT" && verdict !== "REQUEST_CHANGES")
    return "verdict is neither COMMENT nor REQUEST_CHANGES";
  if (
    typeof score !== "number" ||
    !Number.isInteger(score) ||
    score < 1 ||
    score > 5
  )
    return "score is not 1 to 5";
  if (!text(summary, 4000))
    return "summary is missing or over 4,000 characters";
  if (!text(checkSummary, 4000))
    return "checkSummary is missing or over 4,000 characters";
  const comments = list(report.comments ?? []);
  if (!Array.isArray(report.comments ?? []) || comments.length > 30)
    return "comments is not a list of at most 30";
  // Code is posted as written, so text shaped like the stamp a retry looks
  // for is refused wherever it is.
  if (stringsOf(value).some((field) => STAMP_SHAPED.test(field)))
    return "it holds text shaped like Work's review stamp (<!-- work-review:)";
  const checked: WorkReview = {
    reviewedCommit,
    verdict,
    score,
    summary,
    checkSummary,
    comments: [],
    reply: null,
  };
  // A field it may leave out may also be null, as models often write it.
  for (const entry of comments.map(record)) {
    const { path, line, body } = entry;
    const side = entry.side ?? "RIGHT";
    if (
      Object.keys(entry).some(
        (key) => !["path", "line", "side", "body"].includes(key),
      ) ||
      !text(path, 300) ||
      typeof line !== "number" ||
      !Number.isInteger(line) ||
      line < 1 ||
      (side !== "LEFT" && side !== "RIGHT") ||
      !text(body, 1500)
    )
      return "a comment is not { path, line, side?, body } within its limits";
    checked.comments.push({ path, line, side, body });
  }
  if (report.reply != null) {
    const reply = record(report.reply);
    const { inReplyTo, body } = reply;
    if (
      Object.keys(reply).some((key) => !["inReplyTo", "body"].includes(key)) ||
      (inReplyTo != null &&
        (typeof inReplyTo !== "number" ||
          !Number.isSafeInteger(inReplyTo) ||
          inReplyTo < 1)) ||
      !text(body, 4000)
    )
      return "reply is not { inReplyTo?, body } within its limits";
    checked.reply = {
      ...(typeof inReplyTo === "number" ? { inReplyTo } : {}),
      body,
    };
  }
  return checked;
}

function text(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= max
  );
}

/** A filename rendered as literal Markdown text, with no code-span breakout. */
export function renderedPath(path: string): string {
  return path
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\r\n]/g, " ")
    .replace(/[\\`*_{}[\]()#+.!|~-]/g, "\\$&");
}
