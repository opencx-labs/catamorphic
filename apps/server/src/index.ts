import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { lanAddresses, startMdnsResponder } from "./mdns.js";
import { buildStockServer } from "./server.js";

/**
 * The stock Catamorphic server. Zero external services: everything lives
 * under the data dir (default /data — mount it as a volume).
 *
 *   PORT                      listen port (default 4700)
 *   CATAMORPHIC_DATA_DIR      data dir (default /data)
 *   CATAMORPHIC_PUBLIC_URL    public base for invite links (remote setups)
 *   CATAMORPHIC_MDNS          "off" disables LAN discovery; any other
 *                             value is the hostname (default catamorphic-<id>.local, unique per server)
 *   ANTHROPIC_API_KEY | OPENROUTER_API_KEY | OPENAI_API_KEY  enable chat
 *   CATAMORPHIC_MODEL / CATAMORPHIC_EFFORT                   agent tuning
 */
const port = Number(process.env.PORT ?? 4700);
const dataDir = process.env.CATAMORPHIC_DATA_DIR ?? "/data";

/**
 * The default mDNS hostname is UNIQUE per server (a persisted suffix):
 * several people running desktops/servers on one office Wi-Fi must not
 * fight over the same name — mDNS has no referee, and answers would race.
 * Set CATAMORPHIC_MDNS=catamorphic.local if you want the pretty name and
 * know the network is yours.
 */
function serverHostname(): string {
  const file = path.join(dataDir, "server-id");
  let id: string;
  try {
    id = fs.readFileSync(file, "utf8").trim();
    if (!/^[a-z0-9]{4,12}$/.test(id)) throw new Error("regenerate");
  } catch {
    id = randomBytes(3).toString("hex");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, `${id}\n`);
  }
  return `catamorphic-${id}.local`;
}

const mdnsSetting = process.env.CATAMORPHIC_MDNS ?? serverHostname();

const mdns =
  mdnsSetting === "off"
    ? null
    : startMdnsResponder(mdnsSetting, (line) => console.log(line));

const bases = [
  ...(process.env.CATAMORPHIC_PUBLIC_URL
    ? [process.env.CATAMORPHIC_PUBLIC_URL.replace(/\/+$/, "")]
    : []),
  ...(mdns ? [`http://${mdns.hostname}:${port}`] : []),
  ...lanAddresses().map((address) => `http://${address}:${port}`),
  `http://127.0.0.1:${port}`,
];

const server = await buildStockServer({
  dataDir,
  publicBases: bases,
  log: (line) => console.log(line),
});

await server.app.listen({ port, host: "0.0.0.0" });
const primary = bases[0] ?? `http://127.0.0.1:${port}`;
const admin = server.auth.ensureAdmin();

console.log(`
Catamorphic server is up.
  ${server.agentsDescription}
  API:    ${bases.map((base) => `${base}/api`).join("\n          ")}
  Docs:   ${primary}/docs

Create a project, then an invite (connect links come back ready to send):

  curl -s -X POST ${primary}/admin/projects \\
    -H "authorization: Bearer ${admin.token}" \\
    -H "content-type: application/json" -d '{"name":"brain"}'

  curl -s -X POST ${primary}/admin/invites \\
    -H "authorization: Bearer ${admin.token}" \\
    -H "content-type: application/json" -d '{"projectId":"<id>","user":"sam"}'
`);

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: shutting down…`);
  mdns?.close();
  await server.shutdown();
  process.exit(0);
}
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
