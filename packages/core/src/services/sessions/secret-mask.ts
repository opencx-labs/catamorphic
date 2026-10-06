/**
 * Secret values in a turn's recorded output (ADR 0206): every value the
 * turn's sandbox received is replaced with `[secret NAME]` before the
 * output enters the session log. Streamed text is held back while its end
 * could still be the start of a value, so no part of a value is ever
 * recorded, even split across deltas or batches.
 *
 * A mask is working state of the turn its process holds (ADR 0193, rule
 * a): built when the attempt is prepared, and built again from the stored
 * values by whoever takes the turn over.
 */

/** Values shorter than this are not masked: they would match ordinary text. */
export const SECRET_MASK_MIN_LENGTH = 6;

/** One streamed field: an item's `text` or `output`. */
export interface StreamKey {
  itemId: string;
  field: "text" | "output";
}

function keyOf(key: StreamKey): string {
  return `${key.itemId}\u0000${key.field}`;
}

/**
 * The forms a value takes in output: itself; JSON-escaped (inside a
 * string of a tool's JSON result); URL-encoded; base64 (standard, without
 * padding, URL-safe); a multi-line value with LF or CRLF endings and each
 * of its lines. Forms shorter than {@link SECRET_MASK_MIN_LENGTH} are
 * dropped by the caller.
 */
export function secretForms(value: string): string[] {
  if (value.length < SECRET_MASK_MIN_LENGTH) return [];
  const lf = value.replace(/\r\n/g, "\n");
  const texts = /[\r\n]/.test(value)
    ? [value, lf, lf.replace(/\n/g, "\r\n"), ...lf.split("\n")]
    : [value];
  const forms = new Set<string>();
  for (const text of texts) {
    forms.add(text);
    forms.add(JSON.stringify(text).slice(1, -1));
    forms.add(encodeURIComponent(text));
  }
  for (const text of new Set([value, lf])) {
    const base64 = Buffer.from(text).toString("base64");
    forms.add(base64);
    forms.add(base64.replace(/=+$/, ""));
    forms.add(Buffer.from(text).toString("base64url"));
  }
  return [...forms];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One batch's view of a mask's held text, kept only once the batch commits. */
export interface SecretMaskBatch {
  /** Replace every whole value in `text`. */
  text(text: string): string;
  /** A JSON value with every string masked. */
  value<T>(value: T): T;
  /**
   * The part of a streamed delta that can be recorded now; the rest waits
   * for the next delta of the same field.
   */
  stream(key: StreamKey, text: string): string;
  /** What a field still holds, masked, and forget it (its item ended). */
  flush(key: StreamKey): string;
  /** Forget what a field holds: the item's whole content replaced it. */
  drop(key: StreamKey): void;
  /** Fields still holding text. */
  holding(): StreamKey[];
  /** Keep this batch's held text: its events were recorded. */
  commit(): void;
}

export class SecretMask {
  private readonly pattern: RegExp | undefined;
  /** Replica memory (a): the label of each value the claimed turn masks. */
  private readonly labels = new Map<string, string>();
  private readonly values: readonly string[];
  /**
   * Replica memory (a): streamed text of the claimed turn held back while
   * it may begin a value. A holder that takes the turn over starts empty:
   * at most that tail is missing from the stream, never a value recorded.
   */
  private held = new Map<string, { key: StreamKey; text: string }>();

  /**
   * `values`: each secret's name and the value (or values) to mask, each
   * in the forms output carries it: as is, JSON-escaped, URL-encoded,
   * base64, with either line ending, and line by line.
   */
  constructor(values: Readonly<Record<string, string | readonly string[]>>) {
    for (const [name, entry] of Object.entries(values))
      for (const value of typeof entry === "string" ? [entry] : entry)
        for (const form of secretForms(value))
          if (form.length >= SECRET_MASK_MIN_LENGTH && !this.labels.has(form))
            this.labels.set(form, `[secret ${name}]`);
    // Longest first: where two values start at one place, the longer wins.
    this.values = [...this.labels.keys()].sort(
      (left, right) => right.length - left.length,
    );
    this.pattern =
      this.values.length > 0
        ? new RegExp(this.values.map(escapeRegExp).join("|"), "g")
        : undefined;
  }

  /** Nothing to mask. */
  get empty(): boolean {
    return this.values.length === 0;
  }

  text(text: string): string {
    if (!this.pattern || text.length === 0) return text;
    return text.replace(this.pattern, (match) => this.labels.get(match) ?? "");
  }

  value<T>(value: T): T {
    if (!this.pattern || value === undefined || value === null) return value;
    if (typeof value === "string") return this.text(value) as T;
    if (typeof value !== "object") return value;
    return JSON.parse(JSON.stringify(value), (_key, entry: unknown) =>
      typeof entry === "string" ? this.text(entry) : entry,
    ) as T;
  }

  /**
   * Where the recordable part of `text` ends: past every whole value, and
   * before the shortest tail that could still begin one.
   */
  private holdFrom(text: string): number {
    const pattern = this.pattern;
    if (!pattern) return text.length;
    let settled = 0;
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern))
      settled = (match.index ?? 0) + match[0].length;
    const longest = this.values[0]?.length ?? 0;
    for (
      let start = Math.max(settled, text.length - longest + 1);
      start < text.length;
      start += 1
    ) {
      const tail = text.slice(start);
      if (this.values.some((value) => value.startsWith(tail))) return start;
    }
    return text.length;
  }

  /** A view for one batch of events; see {@link SecretMaskBatch}. */
  begin(): SecretMaskBatch {
    const held = new Map(this.held);
    return {
      text: (text) => this.text(text),
      value: (value) => this.value(value),
      stream: (key, text) => {
        if (!this.pattern) return text;
        const id = keyOf(key);
        const combined = (held.get(id)?.text ?? "") + text;
        const at = this.holdFrom(combined);
        if (at < combined.length)
          held.set(id, { key, text: combined.slice(at) });
        else held.delete(id);
        return this.text(combined.slice(0, at));
      },
      flush: (key) => {
        const id = keyOf(key);
        const rest = held.get(id)?.text ?? "";
        held.delete(id);
        return this.text(rest);
      },
      drop: (key) => {
        held.delete(keyOf(key));
      },
      holding: () => [...held.values()].map((entry) => entry.key),
      commit: () => {
        this.held = held;
      },
    };
  }
}
