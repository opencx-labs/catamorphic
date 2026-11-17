import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Regenerates src/main/translation/catalog.json, the pinned list of the
 * translation engine and language models pages use (ADR 0320), from the
 * Remote Settings collections Firefox's own translations read. Run it with
 * `bun apps/desktop/scripts/translation-catalog.ts`, review the diff, and
 * commit it with the change that needs it. Work never reads the
 * collections at runtime: every download is pinned here by SHA-256.
 *
 * Selection follows desktop Firefox's release channel: the engine major
 * version the vendored glue (vendor/bergamot-translator.js) was built for,
 * each pair's newest released model of the supported major version, and no
 * record narrowed to another OS or channel.
 */

const COLLECTIONS =
  "https://firefox.settings.services.mozilla.com/v1/buckets/main/collections";
/** The engine the vendored glue loads (BERGAMOT_MAJOR_VERSION in Firefox). */
const ENGINE_MAJOR = 4;
/** The models that engine reads (LANGUAGE_MODEL_MAJOR_VERSION in Firefox). */
const MODEL_MAJOR = 3;
/** Records every desktop release build receives. */
const DESKTOP_FILTERS = new Set(["", "env.appinfo.OS != 'Android'"]);
const FILE_TYPES: ReadonlySet<string> = new Set([
  "model",
  "lex",
  "vocab",
  "srcvocab",
  "trgvocab",
]);

const remoteRecord = z.object({
  name: z.string(),
  version: z.string(),
  filter_expression: z.string().optional(),
  decompressedHash: z.string(),
  decompressedSize: z.number(),
  attachment: z.object({
    location: z.string(),
    hash: z.string(),
    size: z.number(),
  }),
  fileType: z.string().optional(),
  sourceLanguage: z.string().optional(),
  targetLanguage: z.string().optional(),
});
type RemoteRecord = z.infer<typeof remoteRecord>;

async function records(collection: string): Promise<RemoteRecord[]> {
  const response = await fetch(`${COLLECTIONS}/${collection}/records`);
  if (!response.ok) throw new Error(`${collection}: HTTP ${response.status}`);
  const body = z
    .object({ data: z.array(remoteRecord) })
    .parse(await response.json());
  return body.data.filter((record) =>
    DESKTOP_FILTERS.has(record.filter_expression ?? ""),
  );
}

/** "3.1" → [3, 1]; pre-releases ("3.0a1") are not released models. */
function released(version: string): [number, number] | null {
  const match = /^(\d+)\.(\d+)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function newer(a: string, b: string): boolean {
  const [am = 0, an = 0] = released(a) ?? [];
  const [bm = 0, bn = 0] = released(b) ?? [];
  return am !== bm ? am > bm : an > bn;
}

// Paths are relative to the attachments CDN (TRANSLATION_FILES_ORIGIN).
const file = (record: RemoteRecord) => ({
  path: record.attachment.location,
  bytes: record.attachment.size,
  sha256: record.attachment.hash,
  decompressedBytes: record.decompressedSize,
  decompressedSha256: record.decompressedHash,
});

const engines = (await records("translations-wasm-v2")).filter(
  (record) =>
    record.name === "bergamot-translator" &&
    released(record.version)?.[0] === ENGINE_MAJOR,
);
const engine = engines.reduce<RemoteRecord | undefined>(
  (best, record) =>
    !best || newer(record.version, best.version) ? record : best,
  undefined,
);
if (!engine) throw new Error(`No bergamot-translator ${ENGINE_MAJOR}.x`);

const byPair = new Map<string, RemoteRecord[]>();
for (const record of await records("translations-models-v2")) {
  if (released(record.version)?.[0] !== MODEL_MAJOR) continue;
  const pair = `${record.sourceLanguage}-${record.targetLanguage}`;
  byPair.set(pair, [...(byPair.get(pair) ?? []), record]);
}

const pairs: Record<string, unknown> = {};
for (const pair of [...byPair.keys()].sort()) {
  const all = byPair.get(pair) ?? [];
  const version = all.reduce(
    (best, record) => (newer(record.version, best) ? record.version : best),
    "0.0",
  );
  const files: Record<string, unknown> = {};
  let modelName = "";
  for (const record of all.filter((entry) => entry.version === version)) {
    const type = record.fileType ?? "";
    if (!FILE_TYPES.has(type))
      throw new Error(`${pair}: unknown file type ${type}`);
    if (files[type]) throw new Error(`${pair} ${version}: two ${type} files`);
    files[type] = file(record);
    if (type === "model") modelName = record.name;
  }
  const vocabulary = files.vocab || (files.srcvocab && files.trgvocab);
  if (!files.model || !vocabulary) {
    console.warn(`Skipping ${pair} ${version}: incomplete`);
    continue;
  }
  pairs[pair] = {
    sourceLanguage: all[0]?.sourceLanguage,
    targetLanguage: all[0]?.targetLanguage,
    version,
    // How Firefox's engine worker reads the model's weights.
    gemm: modelName.endsWith("intgemm8.bin")
      ? "int8shiftAll"
      : "int8shiftAlphaAll",
    files,
  };
}

const target = path.join(
  import.meta.dirname,
  "../src/main/translation/catalog.json",
);
fs.writeFileSync(
  target,
  `${JSON.stringify({ engine: { version: engine.version, ...file(engine) }, pairs }, null, 2)}\n`,
);
console.log(
  `Wrote ${Object.keys(pairs).length} pairs and engine ${engine.version} to ${path.relative(process.cwd(), target)}`,
);
