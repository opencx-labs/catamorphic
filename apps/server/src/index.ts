import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { emitLog } from "@catamorphic/otel";
import { startTelemetry } from "@catamorphic/otel/node";
import {
  createWorkServer,
  workServerConfigFromEnv,
} from "@catamorphic/work-server";
import { lanAddresses, startMdnsResponder } from "./mdns.js";

/**
 * The Work server, the prebuilt Catamorphic host (ADR 0059, 0159). Zero
 * external services: everything lives under the data dir (default /data;
 * mount it as a volume).
 *
 *   PORT                 listen port (default 4700)
 *   WORK_OPERATOR_PORT   loopback-only setup port (default 4701)
 *   WORK_DATA_DIR        data dir (default /data)
 *   WORK_PUBLIC_URL      public base for OAuth and connection links
 *   WORK_TRUSTED_PROXIES load balancers whose x-forwarded-for names the
 *                        client (CIDRs), for sign-in limits
 *   WORK_MDNS            "off" disables LAN discovery; any other value is
 *                        the hostname (default work-<id>.local, unique per server)
 *   ANTHROPIC_API_KEY | OPENROUTER_API_KEY | OPENAI_API_KEY  enable chat
 *   WORK_MODEL / WORK_EFFORT                                 agent tuning
 */
const telemetry = startTelemetry({ serviceName: "work-server" });
emitLog({ scope: "work-server", body: "Server starting" });

const port = Number(process.env.PORT ?? 4700);
const operatorPort = Number(process.env.WORK_OPERATOR_PORT ?? 4701);
const config = workServerConfigFromEnv(process.env);
const dataDir = config.dataDir;

/**
 * The default mDNS hostname is UNIQUE per server (a persisted suffix):
 * several people running desktops/servers on one office Wi-Fi must not
 * fight over the same name. mDNS has no referee, and answers would race.
 * Set WORK_MDNS=work.local if you want the pretty name and
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
  return `work-${id}.local`;
}

const mdnsSetting = process.env.WORK_MDNS ?? serverHostname();

const mdns =
  mdnsSetting === "off"
    ? null
    : startMdnsResponder(mdnsSetting, (line) => console.log(line));

// OAuth discovery and invitation links publish only a secure public origin
// or exact loopback (config.publicBases). LAN HTTP remains useful for
// desktop device pairing, but bearer and refresh credentials never cross it.
const loopbackBase = `http://127.0.0.1:${port}`;
const [primary = loopbackBase, ...otherBases] = config.publicBases;
const reachableBases = [
  primary,
  ...(mdns ? [`http://${mdns.hostname}:${port}`] : []),
  ...lanAddresses().map((address) => `http://${address}:${port}`),
  ...otherBases,
].filter((base, index, all) => all.indexOf(base) === index);

const server = await createWorkServer({
  config,
  log: (line) => console.log(line),
});

try {
  await server.operatorApp.listen({ port: operatorPort, host: "127.0.0.1" });
  await server.app.listen({ port, host: "0.0.0.0" });
} catch (error) {
  mdns?.close();
  await server.shutdown();
  throw error;
}

console.log(`
Work server is up.
  ${server.agentsDescription}
  API:    ${reachableBases.map((base) => `${base}/api`).join("\n          ")}
  Docs:   ${primary}/docs
  Sign in: ${primary}/login
  Setup:  http://127.0.0.1:${operatorPort}/_work/operator

Point an AI setup agent at skills/setup-work-server in the Work repository to
configure authentication, projects, ordinary roles, and the first user.
`);

/**
 * Leave before a supervisor's kill: Kubernetes sends SIGKILL 30 seconds
 * after SIGTERM by default, and a step that will not stop must not keep
 * the machine's lease from being given back (ADR 0190).
 */
const SHUTDOWN_DEADLINE_MS = 25_000;

let stopping = false;
async function stop(reason: string, exitCode: number) {
  if (stopping) return;
  stopping = true;
  console.log(`${reason}: shutting down…`);
  const deadline = setTimeout(() => {
    console.error("Shutdown did not finish in time; exiting now");
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  let code = exitCode;
  mdns?.close();
  try {
    await server.shutdown();
  } catch (error) {
    console.error("Shutdown failed:", error);
    code = 1;
  } finally {
    emitLog({ scope: "work-server", body: "Server stopped" });
    await telemetry.shutdown().catch(() => {});
  }
  clearTimeout(deadline);
  process.exit(code);
}
process.on("SIGTERM", () => void stop("SIGTERM", 0));
process.on("SIGINT", () => void stop("SIGINT", 0));
// A machine lease that lapsed never renews (ADR 0190): exit so the
// supervisor (a restart policy, a Kubernetes Deployment) starts a fresh
// process, which registers a new lease.
void server.lost.then(() =>
  stop("This machine's lease is lost and cannot be renewed", 1),
);
