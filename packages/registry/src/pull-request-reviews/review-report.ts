/** What the reviewer reports at the end of a turn, once validated. */
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

/** The reviewer's report: one fenced work-review block (the fence is three backticks). */
const FENCE = "`".repeat(3);
const REPORT_BLOCK = new RegExp(
  `${FENCE}work-review\\n([\\s\\S]*?)\\n${FENCE}`,
  "g",
);

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
 * "@name" and "@org/team" stop notifying, and HTML comments (a fake stamp,
 * a summary marker) are taken apart.
 */
function plain(text: string): string {
  return text.replace(/@(?=[A-Za-z0-9])/g, "@​").replace(/<!--|-->/g, "");
}

/**
 * The turn's one fenced work-review block, checked field by field: a
 * string says why it cannot be used.
 */
export function parseWorkReview(content: string): WorkReview | string {
  const blocks = [...content.matchAll(REPORT_BLOCK)];
  if (blocks.length !== 1)
    return blocks.length === 0
      ? "it has no work-review block"
      : "it has more than one work-review block";
  const source = blocks[0]?.[1] ?? "";
  if (source.length > 65536) return "the block is over 64 KB";
  const parsed = parseJson(source);
  if (
    !parsed ||
    typeof parsed.value !== "object" ||
    parsed.value === null ||
    Array.isArray(parsed.value)
  )
    return "the block is not a JSON object";
  const report = record(parsed.value);
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
  const checked: WorkReview = {
    reviewedCommit,
    verdict,
    score,
    summary: plain(summary),
    checkSummary: plain(checkSummary),
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
    checked.comments.push({ path, line, side, body: plain(body) });
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
      body: plain(body),
    };
  }
  return checked;
}

function text(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= max
  );
}

function parseJson(source: string): { value: unknown } | null {
  try {
    return { value: JSON.parse(source) };
  } catch {
    return null;
  }
}
