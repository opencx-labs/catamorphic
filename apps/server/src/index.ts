import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { lanAddresses, startMdnsResponder } from "./mdns.js";
import { buildStockServer } from "./server.js";

/**
 * The stock Catamorphic server. Zero external services: everything lives
 * under the data dir (default /data; mount it as a volume).
 *
 *   PORT                      listen port (default 4700)
 *   CATAMORPHIC_OPERATOR_PORT loopback-only setup port (default 4701)
 *   CATAMORPHIC_DATA_DIR      data dir (default /data)
 *   CATAMORPHIC_PUBLIC_URL    public base for OAuth and connection links
 *   CATAMORPHIC_MDNS          "off" disables LAN discovery; any other
 *                             value is the hostname (default catamorphic-<id>.local, unique per server)
 *   ANTHROPIC_API_KEY | OPENROUTER_API_KEY | OPENAI_API_KEY  enable chat
 *   CATAMORPHIC_MODEL / CATAMORPHIC_EFFORT                   agent tuning
 */
const port = Number(process.env.PORT ?? 4700);
const operatorPort = Number(process.env.CATAMORPHIC_OPERATOR_PORT ?? 4701);
const dataDir = process.env.CATAMORPHIC_DATA_DIR ?? "/data";

/**
 * The default mDNS hostname is UNIQUE per server (a persisted suffix):
 * several people running desktops/servers on one office Wi-Fi must not
 * fight over the same name. mDNS has no referee, and answers would race.
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

const configuredPublicUrl = process.env.CATAMORPHIC_PUBLIC_URL?.replace(
  /\/+$/,
  "",
);
if (configuredPublicUrl && !isSecurePublicUrl(configuredPublicUrl)) {
  throw new Error(
    "CATAMORPHIC_PUBLIC_URL must use HTTPS except for a loopback address",
  );
}
const loopbackBase = `http://127.0.0.1:${port}`;
// OAuth discovery and invitation links publish only a secure public origin
// or exact loopback. LAN HTTP remains useful for desktop device pairing,
// but bearer and refresh credentials must never cross it.
const connectionBases = [
  ...(configuredPublicUrl ? [configuredPublicUrl] : []),
  loopbackBase,
];
const reachableBases = [
  ...(configuredPublicUrl ? [configuredPublicUrl] : []),
  ...(mdns ? [`http://${mdns.hostname}:${port}`] : []),
  ...lanAddresses().map((address) => `http://${address}:${port}`),
  loopbackBase,
];

const server = await buildStockServer({
  dataDir,
  publicBases: connectionBases,
  log: (line) => console.log(line),
});

await server.operatorApp.listen({ port: operatorPort, host: "127.0.0.1" });
await server.app.listen({ port, host: "0.0.0.0" });
const primary = connectionBases[0] ?? loopbackBase;

console.log(`
Catamorphic server is up.
  ${server.agentsDescription}
  API:    ${reachableBases.map((base) => `${base}/api`).join("\n          ")}
  Docs:   ${primary}/docs
  Sign in: ${primary}/login
  Setup:  http://127.0.0.1:${operatorPort}/_catamorphic/operator

Point an AI setup agent at this repository or catamorphic.ai to configure
authentication, projects, ordinary roles, and the first user.
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

function isSecurePublicUrl(raw: string): boolean {
  const url = new URL(raw);
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        url.hostname === "::1" ||
        /^127(?:\.\d{1,3}){3}$/.test(url.hostname)))
  );
}
