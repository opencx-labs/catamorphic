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
 * Its turn's findings are posted with it; it does not repeat them.
 */
export type WorkReview = {
  reviewedCommit: string;
  verdict: "COMMENT" | "REQUEST_CHANGES";
  score: number;
  summary: string;
  checkSummary: string;
  reply: { inReplyTo?: number; body: string } | null;
};

/**
 * One verified finding, once checked: a `finding` result (ADR 0337), posted
 * as an inline comment the moment it is recorded. `id` names the problem;
 * on one head it posts once.
 */
export type WorkFinding = {
  id: string;
  path: string;
  line: number;
  /** The first line of a range ending at `line`; null for one line. */
  startLine: number | null;
  side: "LEFT" | "RIGHT";
  severity: "blocking" | "important" | "minor";
  title: string;
  body: string;
};

/** A finding's id: letters, digits, `.`, `_` and `-`, so its marker stays whole. */
export const FINDING_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/**
 * Findings a turn posts, and a commit holds: a turn's first 30 distinct
 * ids, as a review once had 30 comments.
 */
export const MAX_FINDINGS = 30;

/**
 * Findings of a turn read, its first submitted first: every one, since a
 * turn makes at most 100 submissions.
 */
export const FINDINGS_READ = 100;

/** A recorded finding as the poster reads it: Work's record of a `finding` result. */
export type RecordedFinding = {
  id: string;
  value: unknown;
  commit: string | null;
  current: boolean;
};

/**
 * A turn's findings, from all its results first submitted first: its
 * first {@link MAX_FINDINGS} distinct valid ids, each as first submitted,
 * and how many distinct valid ids came after them (`withheld`). A value
 * the check refuses, or a second submission of an id, takes no place
 * among the 30.
 */
export function turnFindings(oldestFirst: readonly RecordedFinding[]): {
  findings: Array<{ first: RecordedFinding; finding: WorkFinding }>;
  withheld: number;
} {
  const seen = new Set<string>();
  const findings: Array<{ first: RecordedFinding; finding: WorkFinding }> = [];
  for (const result of oldestFirst) {
    const checked = checkFinding(result.value);
    if (typeof checked === "string" || seen.has(checked.id)) continue;
    seen.add(checked.id);
    if (findings.length < MAX_FINDINGS)
      findings.push({ first: result, finding: checked });
  }
  return { findings, withheld: seen.size - findings.length };
}

/**
 * What a review and its check say of the findings that were not posted:
 * the turn's beyond its first 30 (`withheld`), and those the commit had no
 * room for (`full`).
 */
export function withheldNote(input: {
  withheld: number;
  full: number;
}): string {
  const count = input.withheld + input.full;
  if (count === 0) return "";
  return `${count} more finding${count === 1 ? " was" : "s were"} not posted: a review posts the first ${MAX_FINDINGS} findings of its turn, and a commit holds ${MAX_FINDINGS}.`;
}

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
 * GitHub reads it as CommonMark with GitHub's extensions, and so does this,
 * with a maintained parser. Its code blocks (suggestions included) and code
 * spans are posted exactly as written: GitHub renders neither HTML nor
 * mentions there. Everything else follows one strict rule:
 *
 * - every `&` and `<` is escaped (`&amp;`, `&lt;`), so no HTML, entity or
 *   comment is ever interpreted;
 * - every `@` is followed by a zero-width space, so it mentions no one,
 *   except in a link's destination and in an autolink (`<https://…>`,
 *   `<name@example.com>`), which keep working;
 * - a link keeps its text and destination and drops its title, which only
 *   shows on hover; an image becomes a link to it, its description shown;
 * - a link reference or footnote definition, which shows nothing, has its
 *   `[` escaped and shows as text;
 * - characters people cannot see (zero-width, direction controls, tag
 *   characters) are written out as `\u{…}`.
 *
 * The result is read again until nothing changes, since escaping can
 * change how the rest reads; text that keeps changing, or that the parser
 * cannot read, is escaped whole, code included. Run it once on the whole
 * body GitHub gets, never on its parts one by one.
 */
export function publicationText(text: string): string {
  let current = text;
  try {
    for (let pass = 0; pass < 8; pass += 1) {
      // Longer than a review needs, or nested deeper, which only slows
      // the parser down (it is not linear in tables, long paragraphs of
      // brackets, or nested lists).
      if (current.length > PARSED_LIMIT || tooDeep(current)) break;
      const next = rewritten(current);
      if (next === current) return current;
      current = next;
    }
  } catch {
    // Too deep or too odd to read: escaped whole below.
  }
  // Escaped whole from what was written, never over a pass's own escapes.
  return escapedWhole(text);
}

/**
 * Text escaped whole, code included: nothing in it is HTML, an entity, a
 * mention, a link, a definition or code, so GitHub shows it as written.
 * Only an `&` that would start a character reference is escaped: a bare
 * URL GitHub still links shows a reference in it as written, so one like
 * `?a=1&b=2` keeps its `&`.
 */
function escapedWhole(text: string): string {
  return visible(text)
    .replace(CHARACTER_REFERENCE, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/@(?!\u200b)/g, "@\u200b")
    .replace(/[[`~]/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * An `&` that starts a character reference, other than those this file
 * writes itself (`&amp;`, `&lt;`, and `[`, a backtick and `~` written out).
 */
const CHARACTER_REFERENCE =
  /&(?!amp;|lt;|#91;|#96;|#126;)(?=#[0-9]{1,7};|#[xX][0-9A-Fa-f]{1,6};|[A-Za-z][A-Za-z0-9]{1,31};)/g;

/** The longest text read as Markdown: anything longer is escaped whole. */
const PARSED_LIMIT = 16_384;

/** The most GitHub takes in a body. */
const GITHUB_BODY_LIMIT = 65_536;

/**
 * Room kept beyond the stamp: the blank line before it, and a fence closed
 * before it (twice at most).
 */
const STAMP_HEADROOM = 256;

/** The most of a body posted with `stamp` after it: GitHub's limit less the stamp and its headroom. */
function bodyLimit(stamp: string): number {
  return Math.max(0, GITHUB_BODY_LIMIT - STAMP_HEADROOM - stamp.length);
}

/**
 * Whether `body`, defused, fits GitHub with `stamp` after it, so
 * {@link stampedBody} posts it whole: what a review lists is decided by
 * this, never cut from its end.
 */
export function fitsGithub(body: string, stamp: string): boolean {
  return publicationText(body).length <= bodyLimit(stamp);
}

/**
 * A body to post with this recipe's `stamp` after it: the body defused,
 * cut to fit GitHub's limit after defusing with the stamp (which may be a
 * review's finding markers and its own stamp), and a code block it leaves
 * open closed first, so the stamp is the HTML comment GitHub hides and not
 * text in the block.
 */
export function stampedBody(body: string, stamp: string): string {
  const limit = bodyLimit(stamp);
  let text = publicationText(body);
  if (text.length > limit) text = publicationText(text.slice(0, limit));
  // Escaped whole, it fits: no character grows past ten.
  if (text.length > limit)
    text = escapedWhole(body.slice(0, Math.floor(limit / 10)));
  // Escaped whole, nothing in it is code that could take the stamp.
  if (text.length > PARSED_LIMIT || tooDeep(text))
    return `${escapedWhole(text)}\n\n${stamp}`;
  for (let pass = 0; pass < 2; pass += 1) {
    const stamped = `${text}\n\n${stamp}`;
    const at = text.length + 2;
    let ranges: Array<[number, number]>;
    try {
      ranges = codeRanges(parsed(stamped));
    } catch {
      // Unreadable: with no code left in it, nothing can take the stamp.
      return `${escapedWhole(text)}\n\n${stamp}`;
    }
    const open = ranges.find(([start, end]) => start < at && end > at);
    if (!open) return stamped;
    const fence = /^[ \t>]*(`{3,}|~{3,})/.exec(stamped.slice(open[0]))?.[1];
    text = `${text}\n${fence ?? "```"}`;
  }
  return `${text}\n\n${stamp}`;
}

/**
 * Characters that reorder or hide text even in code: direction overrides,
 * embeddings and isolates, and tag characters. A report holding one is
 * refused rather than posted, so a suggestion cannot read one way and
 * apply another.
 */
const REORDERING = /[‪-‮⁦-⁩\u{E0000}-\u{E007F}]/u;

/** Characters people cannot see, written out where prose has them. */
const INVISIBLE =
  /[\u00AD\u061C\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\u{E0000}-\u{E007F}]|\u034F|\u17B4|\u17B5|[\uFE00-\uFE0E]|[\u{E0100}-\u{E01EF}]/gu;

/** `text` with what people cannot see written out as `\u{…}`. */
function visible(text: string): string {
  return text.replace(INVISIBLE, (char: string, offset: number) => {
    // The zero-width space this recipe puts after an `@`, and the joiner
    // inside an emoji, stay.
    if (char === "​" && text[offset - 1] === "@") return char;
    if (
      char === "‍" &&
      /\p{Extended_Pictographic}️?$/u.test(
        text.slice(Math.max(0, offset - 3), offset),
      ) &&
      /^\p{Extended_Pictographic}/u.test(text.slice(offset + 1, offset + 3))
    )
      return char;
    return `\\u{${(char.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`;
  });
}

/** Prose as this recipe posts it: no HTML, entity, mention or hidden character. */
function prose(text: string): string {
  return visible(text)
    .replace(/&(?!amp;|lt;|#91;|#96;|#126;)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/@(?!​)/g, "@​");
}

/** A link destination as written inside `<…>`, its characters kept literal. */
function destination(url: string): string {
  return url
    .replace(INVISIBLE, (char: string) => encodeURIComponent(char))
    .replace(/[\r\n]/g, (char) => encodeURIComponent(char))
    .replace(/[\\<>&]/g, "\\$&");
}

/** Text that reads as itself inside a link's brackets. */
function label(text: string): string {
  return prose(text).replace(/[\\`*_[\]()!~|#]/g, "\\$&");
}

type MarkdownRoot = ReturnType<typeof fromMarkdown>;
type MarkdownNode = MarkdownRoot | MarkdownRoot["children"][number];

/**
 * `text` parsed as GitHub reads what this recipe posts. Prose never keeps a
 * raw `<` (it is escaped), so only autolinks and code keep theirs: every
 * other `<` is read as a plain character of the same length, and no HTML
 * hides or shifts the code GitHub will see.
 */
function parsed(text: string): MarkdownRoot {
  const autolinks = new Set(
    [...text.matchAll(AUTOLINK)].map((match) => match.index),
  );
  const readable = text.replace(/</g, (char: string, offset: number) =>
    autolinks.has(offset) ? char : "\uE000",
  );
  return fromMarkdown(readable, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
}

/** A CommonMark autolink: `<scheme:…>` or `<name@example.com>`. */
const AUTOLINK =
  /<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>\p{Cc}]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/gu;

/** Whether a line opens more than 32 block quotes or lists. */
function tooDeep(text: string): boolean {
  return text.split("\n").some((line) => {
    const prefix =
      /^(?:[ \t]*(?:>|[-+*](?=[ \t])|\d{1,9}[.)](?=[ \t])))*/.exec(line)?.[0] ??
      "";
    return (prefix.match(/>|[-+*]|\d{1,9}[.)]/g)?.length ?? 0) > 32;
  });
}

function span(node: MarkdownNode): [number, number] | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? undefined : [start, end];
}

function childrenOf(node: MarkdownNode): MarkdownNode[] {
  return "children" in node ? node.children : [];
}

/** Where `text` is code (blocks and spans), as GitHub reads it. */
function codeRanges(root: MarkdownRoot): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const visit = (node: MarkdownNode) => {
    const range = span(node);
    if ((node.type === "code" || node.type === "inlineCode") && range)
      ranges.push(range);
    else for (const child of childrenOf(node)) visit(child);
  };
  visit(root);
  return ranges;
}

/** `text` posted by the rule above, read once. */
function rewritten(text: string): string {
  return within(text, childrenOf(parsed(text)), 0, text.length);
}

/** `text[start, end)` posted by the rule: its nodes rewritten, the rest prose. */
function within(
  text: string,
  nodes: readonly MarkdownNode[],
  start: number,
  end: number,
): string {
  let out = "";
  let at = start;
  for (const node of nodes) {
    const range = span(node);
    if (!range || range[0] < at) continue;
    out += prose(text.slice(at, range[0]));
    out += rewrite(text, node, range);
    at = range[1];
  }
  return out + prose(text.slice(at, end));
}

function rewrite(
  text: string,
  node: MarkdownNode,
  [start, end]: [number, number],
): string {
  switch (node.type) {
    case "code":
    case "inlineCode":
      return text.slice(start, end);
    case "link": {
      // An autolink keeps working as written; a bare URL GitHub links by
      // itself is prose.
      if (text[start] === "<") return text.slice(start, end);
      if (text[start] !== "[") return prose(text.slice(start, end));
      const children = childrenOf(node);
      const last = children.at(-1);
      const labelEnd = (last && span(last)?.[1]) ?? start + 1;
      return `[${within(text, children, start + 1, labelEnd)}](<${destination(node.url)}>)`;
    }
    case "image":
      return `[${label(node.alt ?? node.url)}](<${destination(node.url)}>)`;
    case "definition":
    case "footnoteDefinition": {
      const bracket = text.indexOf("[", start);
      const opening = bracket >= start && bracket < end ? bracket : start;
      return (
        prose(text.slice(start, opening)) +
        "\\" +
        within(text, childrenOf(node), opening, end)
      );
    }
    default:
      return within(text, childrenOf(node), start, end);
  }
}

/**
 * Text shaped like this recipe's stamp (see `marker` in reviews.ts), which
 * a retry finds by a raw search of GitHub bodies, code included.
 */
const STAMP_SHAPED = /<!--\s*work-review:/i;

/**
 * Why a report's text cannot be posted, or undefined. Code is posted as
 * written, so text shaped like the stamp a retry looks for is refused
 * wherever it is, and so are characters that reorder or hide text in it.
 */
function refusedText(value: unknown): string | undefined {
  if (stringsOf(value).some((field) => STAMP_SHAPED.test(field)))
    return "it holds text shaped like Work's review stamp (<!-- work-review:)";
  if (stringsOf(value).some((field) => REORDERING.test(field)))
    return "it holds characters that reorder or hide text (direction controls or tag characters)";
  return undefined;
}

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
  const refused = refusedText(value);
  if (refused) return refused;
  const checked: WorkReview = {
    reviewedCommit,
    verdict,
    score,
    summary,
    checkSummary,
    reply: null,
  };
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

/**
 * A `finding` result, checked field by field again, as a review is: the
 * sandbox that submitted it is untrusted. A string says why it cannot be used.
 * Its text is kept as written and defused whole where it is posted
 * (`findingComment`, a review's body).
 */
export function checkFinding(value: unknown): WorkFinding | string {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "the finding is not a JSON object";
  const entry = record(value);
  const fields = [
    "id",
    "path",
    "line",
    "startLine",
    "side",
    "severity",
    "title",
    "body",
  ];
  if (Object.keys(entry).some((key) => !fields.includes(key)))
    return "it has an unknown field";
  const refused = refusedText(value);
  if (refused) return refused;
  const { id, path, line, title, body } = entry;
  const startLine = entry.startLine ?? null;
  const side = entry.side ?? "RIGHT";
  const severity = entry.severity;
  if (typeof id !== "string" || !FINDING_ID.test(id))
    return "id is not a finding id";
  if (!text(path, 300)) return "path is missing or over 300 characters";
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1)
    return "line is not a line number";
  if (
    startLine !== null &&
    (typeof startLine !== "number" ||
      !Number.isInteger(startLine) ||
      startLine < 1 ||
      startLine >= line)
  )
    return "startLine is not a line before line";
  if (side !== "LEFT" && side !== "RIGHT")
    return "side is neither LEFT nor RIGHT";
  if (
    severity !== "blocking" &&
    severity !== "important" &&
    severity !== "minor"
  )
    return "severity is not blocking, important or minor";
  if (!text(title, 200)) return "title is missing or over 200 characters";
  if (!text(body, 1500)) return "body is missing or over 1,500 characters";
  return {
    id,
    path,
    line,
    startLine: typeof startLine === "number" ? startLine : null,
    side,
    severity,
    title,
    body,
  };
}

/**
 * The stamp a finding carries wherever it is posted, in a review's body: a
 * second post of it on this head finds it and posts nothing.
 */
export function findingMarker(commit: string, id: string): string {
  return `<!-- work-review:${commit}:finding:${id} -->`;
}

/** A review the poster made of findings alone: its body is their markers. */
export function isFindingReview(body: unknown): boolean {
  return (
    typeof body === "string" &&
    /^(?:<!-- work-review:[0-9a-f]{40}:finding:[A-Za-z0-9_.-]+ -->\s*)+$/.test(
      body.trim(),
    )
  );
}

/** Every line a finding covers is one the diff shows on its side. */
export function findingFits(lines: Set<string>, finding: WorkFinding): boolean {
  for (
    let line = finding.startLine ?? finding.line;
    line <= finding.line;
    line++
  )
    if (!lines.has(`${finding.path}:${finding.side}:${line}`)) return false;
  return true;
}

const SEVERITY_LABELS: Record<WorkFinding["severity"], string> = {
  blocking: "Blocking",
  important: "Important",
  minor: "Minor",
};

/**
 * A finding as an inline comment of a review, defused whole as GitHub reads
 * it. Its marker rides along after it, so the review's threads show a
 * resumed reviewer which ids are posted.
 */
export function findingComment(finding: WorkFinding, commit: string) {
  return {
    path: finding.path,
    line: finding.line,
    side: finding.side,
    ...(finding.startLine === null
      ? {}
      : { startLine: finding.startLine, startSide: finding.side }),
    body: stampedBody(
      `**${SEVERITY_LABELS[finding.severity]}:** ${finding.title}\n\n${finding.body}`,
      findingMarker(commit, finding.id),
    ),
  };
}

/** The finding markers a review's body carries. */
export function findingMarkersIn(body: unknown): string[] {
  return typeof body === "string"
    ? (body.match(
        /<!-- work-review:[0-9a-f]{40}:finding:[A-Za-z0-9_.-]+ -->/g,
      ) ?? [])
    : [];
}

/** A finding listed in a review's body, for one the diff cannot hold. */
export function findingLine(finding: WorkFinding): string {
  return `${renderedPath(finding.path)}:${finding.line}: **${SEVERITY_LABELS[finding.severity]}:** ${finding.title}. ${finding.body}`;
}

/** Text that is not blank, at most `max` code points, as its schema counts. */
function text(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    [...value].length <= max
  );
}

/**
 * A filename rendered as literal Markdown text, with no code-span breakout.
 * `[`, a backtick and `~` are character references, which a body escaped
 * whole keeps too (a backslash before one there would show); HTML is left
 * to the cleaning of the whole body it is posted in (`stampedBody`), so a
 * path is escaped once and reads as written.
 */
export function renderedPath(path: string): string {
  return path
    .replace(/[\r\n]/g, " ")
    .replace(/[\\*_{}\]()#+.!|-]/g, "\\$&")
    .replace(/[[`~]/g, (char) => `&#${char.charCodeAt(0)};`);
}
