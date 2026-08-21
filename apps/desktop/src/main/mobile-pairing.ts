import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app as electronApp } from "electron";
import Fastify, { type FastifyInstance } from "fastify";
import type { ProfileConfigManager } from "./profile-config.js";

/**
 * "Continue on mobile" (ADR 0058/0059 companion piece): the desktop is a
 * server the phone can use directly. A LAN-facing listener serves the PWA
 * at its root, exchanges short-lived pairing codes for device tokens, and
 * proxies /api/* to the loopback embedded server — bearer required on
 * every proxied request, because the embedded server answers as the
 * desktop user (root). The QR encodes one single-use code; scanning it
 * hands the phone the desktop connection AND the profile's remote-project
 * links, so projects hosted on a remote server keep talking to that
 * server directly.
 *
 * Multiple desktops on one Wi-Fi never collide: the QR carries this
 * machine's LAN IP and a per-machine persisted port — no shared names,
 * no multicast.
 *
 * Stored state (`<userData>/mobile-pairing.json`): the chosen port and
 * SHA-256 HASHES of device tokens (the token itself exists only in the
 * claim response). Pairing codes live in memory and die in 2 minutes.
 */

const PAIRING_CODE_TTL_MS = 2 * 60_000;
const DEFAULT_PORT = 4756;

export interface PairingContext {
  projectId?: string;
  sessionId?: string;
}

export interface PairingInfo {
  /** What the QR encodes: http://<lan-ip>:<port>/?pair=<code> */
  url: string;
  /** The same URL for every other LAN address this machine has. */
  alternates: string[];
  expiresAt: string;
  /** False when the PWA bundle is missing (the QR would 404). */
  pwaReady: boolean;
}

export interface PairedDevice {
  id: string;
  tokenHash: string;
  profileId: string;
  createdAt: string;
}

interface PairingFile {
  port?: number;
  devices?: PairedDevice[];
}

interface PendingPairing {
  profileId: string;
  context?: PairingContext;
  expiresAt: number;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export class MobilePairingService {
  private lanApp: FastifyInstance | null = null;
  private port: number;
  private devices: PairedDevice[];
  private readonly pending = new Map<string, PendingPairing>();

  constructor(
    private readonly deps: {
      /** `<userData>/mobile-pairing.json` */
      file: string;
      profileConfig: ProfileConfigManager;
      /** Loopback base of the embedded server ("http://127.0.0.1:NNNN"). */
      serverUrl: () => string | null;
      /** Override for tests; defaults next to the repo / packaged resources. */
      pwaDist?: string;
    },
  ) {
    const stored = this.load();
    this.port = stored.port ?? DEFAULT_PORT;
    this.devices = stored.devices ?? [];
  }

  /** Auto-start at boot when phones are already paired — they reconnect. */
  hasDevices(): boolean {
    return this.devices.length > 0;
  }

  /** Begin a pairing: ensure the LAN listener, mint a single-use code. */
  async createPairing(
    profileId: string,
    context?: PairingContext,
  ): Promise<PairingInfo> {
    await this.ensureListening();
    const code = randomBytes(16).toString("base64url");
    const expiresAt = Date.now() + PAIRING_CODE_TTL_MS;
    this.pending.set(code, {
      profileId,
      ...(context ? { context } : {}),
      expiresAt,
    });
    setTimeout(() => this.pending.delete(code), PAIRING_CODE_TTL_MS).unref?.();
    const addresses = lanIps();
    const urls = (addresses.length > 0 ? addresses : ["127.0.0.1"]).map(
      (ip) => `http://${ip}:${this.port}/?pair=${code}`,
    );
    return {
      url: urls[0] as string,
      alternates: urls.slice(1),
      expiresAt: new Date(expiresAt).toISOString(),
      pwaReady: fs.existsSync(path.join(this.pwaDist(), "index.html")),
    };
  }

  async ensureListening(): Promise<void> {
    if (this.lanApp) return;
    const app = Fastify({ bodyLimit: 96 * 1024 * 1024 });

    app.post("/pair/claim", async (request, reply) => {
      const body = (request.body ?? {}) as { code?: string };
      const entry = body.code ? this.pending.get(body.code) : undefined;
      if (!entry || entry.expiresAt < Date.now()) {
        return reply
          .status(410)
          .send({ error: "This code expired — scan a fresh QR." });
      }
      this.pending.delete(body.code as string);
      const token = randomBytes(32).toString("base64url");
      this.devices.push({
        id: randomUUID(),
        tokenHash: hashToken(token),
        profileId: entry.profileId,
        createdAt: new Date().toISOString(),
      });
      this.save();
      // The phone talks to whichever address it scanned; build the API
      // base from the Host it actually used.
      const server = `http://${request.headers.host}/api`;
      return reply.send({
        version: 1,
        name: os.hostname(),
        server,
        token,
        remotes: this.remoteLinks(entry.profileId),
        ...(entry.context ? { context: entry.context } : {}),
      });
    });

    // The API surface: bearer-gated proxy onto the loopback embedded
    // server. EVERY request needs a device token — the embedded server
    // itself has no auth and answers as the desktop user.
    app.all("/api/*", async (request, reply) => {
      if (!this.authorized(request.headers.authorization)) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      const upstream = this.deps.serverUrl();
      if (!upstream) {
        return reply
          .status(503)
          .send({ error: "The desktop is still booting" });
      }
      const url = `${upstream}${request.url}`;
      const method = request.method;
      const hasBody = method !== "GET" && method !== "HEAD";
      const response = await fetch(url, {
        method,
        headers: {
          ...(typeof request.headers["content-type"] === "string"
            ? { "content-type": request.headers["content-type"] }
            : {}),
        },
        ...(hasBody && request.body !== undefined && request.body !== null
          ? { body: JSON.stringify(request.body) }
          : {}),
      });
      const text = await response.text();
      return reply
        .status(response.status)
        .header(
          "content-type",
          response.headers.get("content-type") ?? "application/json",
        )
        .send(text);
    });

    // Everything else is the PWA bundle (hash-routed SPA: unknown paths
    // fall back to index.html).
    app.get("/*", async (request, reply) => {
      const dist = this.pwaDist();
      if (!fs.existsSync(path.join(dist, "index.html"))) {
        return reply
          .status(503)
          .type("text/plain")
          .send(
            "The mobile app bundle is missing. Build it first: bun run --filter catamorphic-pwa build",
          );
      }
      const requested = decodeURIComponent(
        (request.url.split("?")[0] ?? "/").replace(/^\/+/, ""),
      );
      const resolved = path.resolve(dist, requested || "index.html");
      const file =
        resolved.startsWith(dist) &&
        fs.existsSync(resolved) &&
        fs.statSync(resolved).isFile()
          ? resolved
          : path.join(dist, "index.html");
      return reply
        .type(CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream")
        .send(fs.readFileSync(file));
    });

    // The persisted port keeps paired phones working across restarts;
    // walk forward when something else holds it (two desktop installs).
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await app.listen({ port: this.port, host: "0.0.0.0" });
        this.lanApp = app;
        this.save();
        return;
      } catch (error) {
        if ((error as { code?: string }).code === "EADDRINUSE") {
          this.port += 1;
          continue;
        }
        throw error;
      }
    }
    throw new Error("No free port for the mobile listener");
  }

  async stop(): Promise<void> {
    await this.lanApp?.close();
    this.lanApp = null;
  }

  private authorized(header: string | string[] | undefined): boolean {
    const raw = Array.isArray(header) ? header[0] : header;
    const match = raw ? /^Bearer\s+(\S+)$/i.exec(raw.trim()) : null;
    if (!match?.[1]) return false;
    const hash = hashToken(match[1]);
    return this.devices.some((device) => device.tokenHash === hash);
  }

  /**
   * The profile's remote-project links, decrypted: projects hosted on a
   * remote server pair straight through — the phone talks to that server
   * directly, not through this desktop.
   */
  private remoteLinks(profileId: string) {
    const store = this.deps.profileConfig.forProfile(profileId).remoteProjects;
    const seen = new Set<string>();
    const links: Array<{
      server: string;
      token: string;
      project: string;
      name: string;
    }> = [];
    for (const localProjectId of Object.keys(store.list())) {
      const link = store.get(localProjectId);
      if (!link?.token) continue;
      const key = `${link.serverUrl}:${link.remoteProjectId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({
        server: link.serverUrl,
        token: link.token,
        project: link.remoteProjectId,
        name: link.remoteProjectName,
      });
    }
    return links;
  }

  private pwaDist(): string {
    if (this.deps.pwaDist) return this.deps.pwaDist;
    if (process.env.CATAMORPHIC_PWA_DIST) {
      return process.env.CATAMORPHIC_PWA_DIST;
    }
    // Dev/e2e: the workspace sibling. Packaged: bundled resources.
    const workspace = path.resolve(electronApp.getAppPath(), "../pwa/dist");
    if (fs.existsSync(workspace)) return workspace;
    return path.join(process.resourcesPath ?? "", "pwa");
  }

  private load(): PairingFile {
    try {
      return JSON.parse(fs.readFileSync(this.deps.file, "utf8")) as PairingFile;
    } catch {
      return {};
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.deps.file), { recursive: true });
    fs.writeFileSync(
      this.deps.file,
      `${JSON.stringify({ port: this.port, devices: this.devices }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function lanIps(): string[] {
  const ips: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) ips.push(entry.address);
    }
  }
  return ips;
}
