/*
 * Pure helpers `postReviews` checks a review with before it posts: no IO,
 * so every boundary that calls them replays alike.
 */

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
 * One verified finding, once checked: a `finding` result (ADR 0336), posted
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

/** Findings of a turn read, its first submitted first. */
export const FINDINGS_READ = 100;

/** A recorded finding as the poster reads it: Work's record of a `finding` result. */
export type RecordedFinding = {
  id: string;
  value: unknown;
  commit: string | null;
  current: boolean;
};

/**
 * A turn's findings, from its results first submitted first (at most
 * {@link FINDINGS_READ}): its first {@link MAX_FINDINGS} distinct valid
 * ids, each as first submitted, and how many distinct valid ids came after
 * them (`withheld`; `more` when the read was full, so there may be more).
 * A value the check refuses, or a second submission of an id, takes no
 * place among the 30.
 */
export function turnFindings(oldestFirst: readonly RecordedFinding[]): {
  findings: Array<{ first: RecordedFinding; finding: WorkFinding }>;
  withheld: number;
  more: boolean;
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
  return {
    findings,
    withheld: seen.size - findings.length,
    more: oldestFirst.length >= FINDINGS_READ,
  };
}

/** What a review says of the findings it could not post. */
export function withheldNote(input: {
  count: number;
  more: boolean;
  full: number;
}): string {
  const count = input.count + input.full;
  if (count === 0 && !input.more) return "";
  const many = `${input.more ? "At least " : ""}${count} more finding${count === 1 && !input.more ? " was" : "s were"} not posted`;
  return `${many}: a review posts the first ${MAX_FINDINGS} findings of its turn, and a commit holds ${MAX_FINDINGS}.`;
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
 * Every `<` that would open a comment (a fake stamp, a summary marker), a
 * declaration such as `<!DOCTYPE …>` or `<![CDATA[`, or a processing
 * instruction (`<?…?>`), all of which GitHub drops from a body, gets a
 * zero-width space after it, so none opens, however the text nests them,
 * and nothing is removed: the words, code spans included, read as written.
 * "@name" and "@org/team" stop notifying the same way.
 */
export function publicationText(text: string): string {
  return text
    .replace(/<(?=[!?])/g, "<\u200b")
    .replace(/@(?=[A-Za-z0-9])/g, "@\u200b");
}

/**
 * The turn's `review` result, checked field by field again: the sandbox
 * that submitted it is untrusted, and its schema is project code. A string
 * says why it cannot be used.
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
  const checked: WorkReview = {
    reviewedCommit,
    verdict,
    score,
    summary: publicationText(summary),
    checkSummary: publicationText(checkSummary),
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
      body: publicationText(body),
    };
  }
  return checked;
}

/**
 * A `finding` result, checked field by field again, as a review is: the
 * sandbox that submitted it is untrusted. A string says why it cannot be used.
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
    title: publicationText(title),
    body: publicationText(body),
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
 * A finding as an inline comment of a review. Its marker rides along, so
 * the review's threads show a resumed reviewer which ids are posted.
 */
export function findingComment(finding: WorkFinding, commit: string) {
  return {
    path: finding.path,
    line: finding.line,
    side: finding.side,
    ...(finding.startLine === null
      ? {}
      : { startLine: finding.startLine, startSide: finding.side }),
    body: `**${SEVERITY_LABELS[finding.severity]}:** ${finding.title}\n\n${finding.body}\n\n${findingMarker(commit, finding.id)}`,
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
