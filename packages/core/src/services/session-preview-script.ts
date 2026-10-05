import { createHash } from "node:crypto";

/** Most response bytes a preview carries (ADR 0208). */
export const PREVIEW_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Responses larger than this leave the sandbox as a file read separately,
 * so no single command's output grows past what every backend carries.
 */
export const PREVIEW_INLINE_RESPONSE_BYTES = 4 * 1024 * 1024;

/** The line the script answers with: this marker, then one JSON object. */
export const PREVIEW_ANSWER_MARKER = "WORK-PREVIEW ";

/**
 * The script that makes a preview's request inside a chat's sandbox (ADR
 * 0208), with the sandbox's own runtime (Bun, or Node 20+), so it reaches
 * a server listening on the sandbox's loopback on every backend and behind
 * restricted egress. Its argument is a request file (JSON: port, method,
 * path, header pairs, base64 body, where a large response goes), which it
 * removes once read. It answers with one line on standard output.
 *
 * It speaks HTTP/1.1 itself (`node:http`), so bodies pass byte for byte,
 * compressed or not, and every `Set-Cookie` survives. Redirects are
 * answered, never followed.
 */
export const PREVIEW_FETCH_SCRIPT = `// Work preview request (ADR 0208).
import { request } from "node:http";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const LIMIT = ${PREVIEW_RESPONSE_MAX_BYTES};
const INLINE = ${PREVIEW_INLINE_RESPONSE_BYTES};
const HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "trailers", "transfer-encoding", "upgrade", "host", "content-length"];

let answered = false;
function answer(result) {
  if (answered) return;
  answered = true;
  process.stdout.write("${PREVIEW_ANSWER_MARKER}" + JSON.stringify(result) + "\\n", () => process.exit(0));
}

const file = process.argv[2];
let spec;
try {
  spec = JSON.parse(readFileSync(file, "utf8"));
} finally {
  try { unlinkSync(file); } catch {}
}

// Large answers earlier requests left behind.
const responses = dirname(spec.responseFile);
mkdirSync(responses, { recursive: true });
for (const name of readdirSync(responses)) {
  try {
    const path = join(responses, name);
    if (Date.now() - statSync(path).mtimeMs > 120000) unlinkSync(path);
  } catch {}
}

const named = [];
for (const [name, value] of spec.headers)
  if (name.toLowerCase() === "connection")
    for (const token of value.split(",")) named.push(token.trim().toLowerCase());
const headers = {};
for (const [name, value] of spec.headers) {
  const key = name.toLowerCase();
  if (HOP.includes(key) || named.includes(key)) continue;
  headers[key] = key in headers ? headers[key] + (key === "cookie" ? "; " : ", ") + value : value;
}
const body = spec.bodyBase64 ? Buffer.from(spec.bodyBase64, "base64") : undefined;
if (body) headers["content-length"] = String(body.length);

const outgoing = request(
  { host: "127.0.0.1", port: spec.port, method: spec.method, path: spec.path, headers, agent: false },
  (response) => {
    const chunks = [];
    let size = 0;
    response.on("data", (chunk) => {
      size += chunk.length;
      if (size > LIMIT) {
        answer({ error: "too_large", message: "The response is larger than 16 MiB" });
        response.destroy();
        return;
      }
      chunks.push(chunk);
    });
    response.on("error", (error) => answer({ error: "failed", message: error.message }));
    response.on("end", () => {
      const bytes = Buffer.concat(chunks);
      const raw = response.rawHeaders ?? [];
      const pairs = [];
      for (let index = 0; index + 1 < raw.length; index += 2) pairs.push([raw[index], raw[index + 1]]);
      if (pairs.length === 0)
        for (const [name, value] of Object.entries(response.headers))
          for (const one of [].concat(value)) pairs.push([name, String(one)]);
      const head = {
        status: response.statusCode ?? 502,
        headers: pairs.filter(([name]) => !HOP.includes(name.toLowerCase())),
        bytes: bytes.length,
      };
      if (bytes.length > INLINE) {
        writeFileSync(spec.responseFile, bytes.toString("base64"));
        answer({ ...head, bodyFile: true });
      } else answer({ ...head, bodyBase64: bytes.toString("base64") });
    });
  },
);
outgoing.setTimeout(100000, () => outgoing.destroy(new Error("The server did not answer within 100 seconds")));
outgoing.on("error", (error) =>
  answer({ error: error.code === "ECONNREFUSED" ? "unreachable" : "failed", message: error.message }),
);
outgoing.end(body);
`;

/** The script's file name: a new script never overwrites one in use. */
export const PREVIEW_FETCH_SCRIPT_NAME = `fetch-${createHash("sha256")
  .update(PREVIEW_FETCH_SCRIPT)
  .digest("hex")
  .slice(0, 12)}.mjs`;
