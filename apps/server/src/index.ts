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
 *                             value is the hostname (default catamorphic.local)
 *   ANTHROPIC_API_KEY | OPENROUTER_API_KEY | OPENAI_API_KEY  enable chat
 *   CATAMORPHIC_MODEL / CATAMORPHIC_EFFORT                   agent tuning
 */
const port = Number(process.env.PORT ?? 4700);
const dataDir = process.env.CATAMORPHIC_DATA_DIR ?? "/data";
const mdnsSetting = process.env.CATAMORPHIC_MDNS ?? "catamorphic.local";

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
