import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveSpaDist } from "@catamorphic/fastify-plugin";
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
  /**
   * When the focused project is linked to a remote server: the SAME
   * project on that server's own PWA origin (session included — mirroring
   * keeps it there). Works from anywhere, survives this desktop dying,
   * and behind TLS it's the origin worth installing from.
   */
  remote?: { url: string; host: string };
}

export interface PairedDevice {
  id: string;
  tokenHash: string;
  profileId: string;
  /** Best-effort from the claiming request's user agent ("iPhone", …). */
  label: string;
  createdAt: string;
  lastSeenAt?: string;
}

/** What the renderer's device list shows (never the hash). */
export interface PairedDeviceInfo {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
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
    this.devices = (stored.devices ?? []).map((device) => ({
      ...device,
      label: device.label ?? "Device",
    }));
  }

  /** Auto-start at boot when phones are already paired — they reconnect. */
  hasDevices(): boolean {
    return this.devices.length > 0;
  }

  /** The profile's paired devices, for the management UI. */
  listDevices(profileId: string): PairedDeviceInfo[] {
    return this.devices
      .filter((device) => device.profileId === profileId)
      .map((device) => ({
        id: device.id,
        label: device.label,
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt ?? null,
      }));
  }

  /** Cut a device off: its token stops working on the next request. */
  revokeDevice(deviceId: string): boolean {
    const before = this.devices.length;
    this.devices = this.devices.filter((device) => device.id !== deviceId);
    if (this.devices.length === before) return false;
    this.save();
    return true;
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
    const remote = this.remotePairing(profileId, context);
    const addresses = lanIps();
    const urls = (addresses.length > 0 ? addresses : ["127.0.0.1"]).map(
      (ip) => `http://${ip}:${this.port}/?pair=${code}`,
    );
    return {
      url: urls[0] as string,
      alternates: urls.slice(1),
      expiresAt: new Date(expiresAt).toISOString(),
      pwaReady: fs.existsSync(path.join(this.pwaDist(), "index.html")),
      ...(remote ? { remote } : {}),
    };
  }

  /**
   * The remote-origin form of this pairing, when the focused project is
   * linked to a server (ADR 0055): the member's own token + project on
   * the server's PWA origin — no pairing code involved, because the
   * credentials already exist and the origin is durable.
   */
  private remotePairing(
    profileId: string,
    context?: PairingContext,
  ): { url: string; host: string } | undefined {
    if (!context?.projectId) return undefined;
    const link = this.deps.profileConfig
      .forProfile(profileId)
      .remoteProjects.get(context.projectId);
    if (!link?.token) return undefined;
    const origin = link.serverUrl.replace(/\/+$/, "").replace(/\/api$/, "");
    const params = new URLSearchParams({
      server: link.serverUrl.replace(/\/+$/, ""),
      token: link.token,
      project: link.remoteProjectId,
      name: link.remoteProjectName,
    });
    // Mirroring (ADR 0061) puts the focused chat on the server under the
    // SAME id — the phone can land straight in it.
    if (context.sessionId) params.set("session", context.sessionId);
    return {
      url: `${origin}/?${params.toString()}`,
      host: new URL(origin).host,
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
        label: deviceLabel(request.headers["user-agent"]),
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

    // The API surface lives in its own plugin scope so its raw-body
    // parser (below) cannot affect this listener's JSON routes.
    await app.register(async (proxy) => {
      // A proxy, not a JSON API: keep every body as raw bytes so
      // uploads and non-JSON content types reach the embedded server
      // unchanged (Fastify would otherwise 415 or re-encode them).
      proxy.addContentTypeParser(
        "*",
        { parseAs: "buffer" },
        (_request, body, done) => done(null, body),
      );
      proxy.removeContentTypeParser(["application/json", "text/plain"]);
      proxy.addContentTypeParser(
        "application/json",
        { parseAs: "buffer" },
        (_request, body, done) => done(null, body),
      );

      // The API surface: bearer-gated proxy onto the loopback embedded
      // server. EVERY request needs a device token — the embedded server
      // itself has no auth and answers as the desktop user.
      proxy.all("/api/*", async (request, reply) => {
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
        const body = Buffer.isBuffer(request.body) ? request.body : undefined;
        const response = await fetch(url, {
          method,
          headers: {
            ...(typeof request.headers["content-type"] === "string"
              ? { "content-type": request.headers["content-type"] }
              : {}),
          },
          ...(body && body.length > 0 && method !== "GET" && method !== "HEAD"
            ? { body }
            : {}),
        });
        const payload = Buffer.from(await response.arrayBuffer());
        return reply
          .status(response.status)
          .header(
            "content-type",
            response.headers.get("content-type") ?? "application/json",
          )
          .send(payload);
      });
    });

    // Everything else is the PWA bundle (hash-routed SPA: unknown paths
    // fall back to index.html). Shared with the stock server's root so
    // both origins serve identically.
    serveSpaDist(app, () => this.pwaDist());

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
    const device = this.devices.find((entry) => entry.tokenHash === hash);
    if (!device) return false;
    // lastSeen keeps the device list honest; persist at most once a minute
    // (the phone polls every 500ms while a turn runs).
    const now = Date.now();
    const last = device.lastSeenAt ? Date.parse(device.lastSeenAt) : 0;
    if (now - last > 60_000) {
      device.lastSeenAt = new Date(now).toISOString();
      this.save();
    }
    return true;
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
      /** The DESKTOP project this remote mirrors — the phone uses it to
       * offer the remote as the way in when this desktop is asleep. */
      localProjectId: string;
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
        localProjectId,
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

/** A human name for the device list, best-effort from the user agent. */
function deviceLabel(userAgent: string | string[] | undefined): string {
  const ua = (Array.isArray(userAgent) ? userAgent[0] : userAgent) ?? "";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android phone";
  if (/Macintosh/i.test(ua)) return "Mac browser";
  if (/Windows/i.test(ua)) return "Windows browser";
  return "Device";
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
