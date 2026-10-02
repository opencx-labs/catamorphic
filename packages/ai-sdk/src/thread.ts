import type { JsonValue } from "@catamorphic/agent-protocol";
import { type ModelMessage, modelMessageSchema } from "ai";
import { z } from "zod";

/**
 * The built-in agent's native thread (ADR 0197) is its AI SDK message
 * history, stored with Work as append-only entries: one `turn` entry with
 * the turn's input, one `step` entry per finished model step, and a
 * `turn_end` boundary a fork or a retry cuts at. Any replica, or a new
 * process, folds the entries back into the same history.
 */
export type ThreadEntry =
  | {
      v: 1;
      kind: "turn";
      /** The turn's native ref (its attempt id), named again by `turn_end`. */
      ref: string;
      input: ModelMessage[];
      /** Trailing messages a retry replaced: dropped before `input`. */
      drop?: number;
    }
  | {
      v: 1;
      kind: "step";
      /** The model that wrote the step; another model gets it without reasoning. */
      model?: string;
      messages: ModelMessage[];
    }
  | {
      v: 1;
      kind: "turn_end";
      ref: string;
      status: "completed" | "failed" | "interrupted";
    };

const entrySchema = z.discriminatedUnion("kind", [
  z.object({
    v: z.literal(1),
    kind: z.literal("turn"),
    ref: z.string(),
    input: z.array(modelMessageSchema),
    drop: z.number().int().min(0).optional(),
  }),
  z.object({
    v: z.literal(1),
    kind: z.literal("step"),
    model: z.string().optional(),
    messages: z.array(modelMessageSchema),
  }),
  z.object({
    v: z.literal(1),
    kind: z.literal("turn_end"),
    ref: z.string(),
    status: z.enum(["completed", "failed", "interrupted"]),
  }),
]);

/** Stored entries back into typed ones; a malformed entry fails loudly. */
export function parseThreadEntries(
  entries: readonly JsonValue[],
): ThreadEntry[] {
  return entries.map((entry, index) => {
    const parsed = entrySchema.safeParse(entry);
    if (!parsed.success)
      throw new Error(
        `The stored conversation has an entry this agent cannot read (entry ${index + 1}): ${parsed.error.message}`,
      );
    return parsed.data;
  });
}

/**
 * Entries as stored, each small enough for one runner frame: a long step
 * is stored message by message, and media too large for a frame (a
 * screenshot a tool returned) is kept out of the stored history, said so
 * in its place. The live turn still saw it.
 */
export function storedEntries(entry: ThreadEntry): JsonValue[] {
  const encoded = toJsonValue(entry);
  if (JSON.stringify(encoded).length <= STORED_ENTRY_CHARS) return [encoded];
  if (entry.kind === "step" && entry.messages.length > 1)
    return entry.messages.flatMap((message) =>
      storedEntries({ ...entry, messages: [message] }),
    );
  return [withoutLargeMedia(encoded)];
}

/** An entry's limit, which keeps the stored conversation small to reload. */
const STORED_ENTRY_CHARS = 256 * 1024;
const STORED_MEDIA_CHARS = 64 * 1024;
const MEDIA_PART_TYPES = new Set(["image", "file", "image-data", "file-data"]);

function withoutLargeMedia(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(withoutLargeMedia);
  if (value === null || typeof value !== "object") return value;
  if (
    typeof value.type === "string" &&
    MEDIA_PART_TYPES.has(value.type) &&
    JSON.stringify(value).length > STORED_MEDIA_CHARS
  )
    return {
      type: "text",
      text: "[Media omitted from the stored conversation: it was too large to keep.]",
    };
  const object: { [key: string]: JsonValue } = {};
  for (const [key, field] of Object.entries(value))
    object[key] = withoutLargeMedia(field);
  return object;
}

export interface FoldedThread {
  messages: ModelMessage[];
  /** Where the last turn's input ended in `messages`, when there was a turn. */
  lastTurnInputEnd?: number;
}

/**
 * Fold entries into the model history. Steps written by another model than
 * `model` lose their reasoning parts (signed by the model that produced
 * them, rejected by another); `sanitize` strips reasoning everywhere.
 */
export function foldThread(input: {
  entries: readonly ThreadEntry[];
  model?: string;
  sanitize?: boolean;
}): FoldedThread {
  const messages: ModelMessage[] = [];
  let lastTurnInputEnd: number | undefined;
  for (const entry of input.entries) {
    if (entry.kind === "turn") {
      if (entry.drop) messages.splice(messages.length - entry.drop);
      messages.push(...entry.input);
      lastTurnInputEnd = messages.length;
    } else if (entry.kind === "step") {
      const foreign =
        input.sanitize === true ||
        (input.model !== undefined &&
          entry.model !== undefined &&
          entry.model !== input.model);
      messages.push(
        ...(foreign ? stripReasoning(entry.messages) : entry.messages),
      );
    }
  }
  return {
    messages,
    ...(lastTurnInputEnd === undefined ? {} : { lastTurnInputEnd }),
  };
}

/**
 * The entries through the end of the turn `ref` names, for a fork; undefined
 * when that turn never ended in this thread.
 */
export function entriesThroughTurn(
  entries: readonly ThreadEntry[],
  ref: string,
): ThreadEntry[] | undefined {
  for (let end = entries.length - 1; end >= 0; end -= 1) {
    const entry = entries[end];
    if (entry?.kind === "turn_end" && entry.ref === ref)
      return entries.slice(0, end + 1);
  }
  return undefined;
}

/**
 * Drop reasoning parts from assistant history. Reasoning output is signed
 * by the model that produced it; after a mid-conversation model switch the
 * new model rejects those signatures ("encrypted reasoning" errors).
 */
export function stripReasoning(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content))
      return message;
    return {
      ...message,
      content: message.content.filter(
        (part) => part.type !== "reasoning" && part.type !== "reasoning-file",
      ),
    };
  });
}

/**
 * Any value as JSON: binary data becomes base64, URLs and dates strings,
 * functions and undefined fields disappear. Model messages and tool values
 * cross the runner protocol this way.
 */
export function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (value instanceof ArrayBuffer)
    return Buffer.from(new Uint8Array(value)).toString("base64");
  if (value instanceof URL) return value.href;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") {
    const object: { [key: string]: JsonValue } = {};
    for (const [key, field] of Object.entries(value)) {
      if (field === undefined || typeof field === "function") continue;
      object[key] = toJsonValue(field);
    }
    return object;
  }
  return null;
}
