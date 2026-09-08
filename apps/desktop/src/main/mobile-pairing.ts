import { createHash, randomBytes, randomUUID } from "node:crypto";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  pwaManifestWithLaunch,
  serveSpaDist,
} from "@catamorphic/fastify-plugin";
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
const INSTALL_CODE_TTL_MS = 10 * 60_000;
const DEFAULT_PORT = 4756;
const LOCAL_NETWORK_PROBE_TIMEOUT_MS = 60_000;

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
  /** Additional credentials for isolated installed-app storage containers. */
  additionalTokenHashes?: string[];
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
  installs?: PendingInstall[];
}

interface PendingPairing {
  profileId: string;
  context?: PairingContext;
  expiresAt: number;
}

interface PendingInstall {
  codeHash: string;
  deviceId: string;
  profileId: string;
  context?: PairingContext;
  expiresAt: number;
}

interface MobilePairingDeps {
  /** `<userData>/mobile-pairing.json` */
  file: string;
  profileConfig: ProfileConfigManager;
  /** Loopback base of the embedded server ("http://127.0.0.1:NNNN"). */
  serverUrl: () => string | null;
  /** Override for tests; defaults next to the repo / packaged resources. */
  pwaDist?: string;
  /** Test seams for the OS-facing listener and network interfaces. */
  listen?: () => Promise<void>;
  lanAddresses?: () => string[];
  requestLocalNetworkAccess?: () => Promise<void>;
  platform?: NodeJS.Platform;
}

export class MobilePairingService {
  private lanApp: FastifyInstance | null = null;
  private listenerStart: Promise<void> | null = null;
  private listening = false;
  private port: number;
  private devices: PairedDevice[];
  private installs: PendingInstall[];
  private readonly pending = new Map<string, PendingPairing>();

  constructor(private readonly deps: MobilePairingDeps) {
    const stored = this.load();
    this.port = stored.port ?? DEFAULT_PORT;
    this.devices = (stored.devices ?? []).map((device) => ({
      ...device,
      label: device.label ?? "Device",
    }));
    this.installs = (stored.installs ?? []).filter(
      (install) => install.expiresAt > Date.now(),
    );
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
    this.installs = this.installs.filter(
      (install) => install.deviceId !== deviceId,
    );
    this.save();
    return true;
  }

  /** Begin a pairing: ensure the LAN listener, mint a single-use code. */
  async createPairing(
    profileId: string,
    context?: PairingContext,
  ): Promise<PairingInfo> {
    this.assertPwaReady();
    await this.ensureListening();
    const addresses = this.deps.lanAddresses?.() ?? lanIps();
    if (addresses.length === 0) {
      const device =
        (this.deps.platform ?? process.platform) === "darwin"
          ? "this Mac"
          : "this computer";
      throw new Error(
        `Catamorphic could not find a local network address. Connect ${device} and your phone to the same Wi-Fi, then try again.`,
      );
    }
    await this.requestLocalNetworkAccess();
    const code = randomBytes(16).toString("base64url");
    const expiresAt = Date.now() + PAIRING_CODE_TTL_MS;
    this.pending.set(code, {
      profileId,
      ...(context ? { context } : {}),
      expiresAt,
    });
    setTimeout(() => this.pending.delete(code), PAIRING_CODE_TTL_MS).unref?.();
    const remote = this.remotePairing(profileId, context);
    const urls = addresses.map(
      (ip) => `http://${ip}:${this.port}/?pair=${code}`,
    );
    return {
      url: urls[0] as string,
      alternates: urls.slice(1),
      expiresAt: new Date(expiresAt).toISOString(),
      ...(remote ? { remote } : {}),
    };
  }

  /**
   * The remote-origin form of this pairing, when the focused project is
   * linked to a server: a credential-free locator on the server's PWA
   * origin. The phone signs in as itself and never inherits desktop access.
   */
  private remotePairing(
    profileId: string,
    context?: PairingContext,
  ): { url: string; host: string } | undefined {
    if (!context?.projectId) return undefined;
    const link = this.deps.profileConfig
      .forProfile(profileId)
      .remoteProjects.get(context.projectId);
    if (!link) return undefined;
    const origin = link.serverUrl.replace(/\/+$/, "").replace(/\/api$/, "");
    const params = new URLSearchParams({
      server: link.serverUrl.replace(/\/+$/, ""),
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
    if (this.listening || this.lanApp) return;
    if (this.listenerStart) return this.listenerStart;
    const start = this.startListening();
    this.listenerStart = start;
    try {
      await start;
      this.listening = true;
    } finally {
      if (this.listenerStart === start) this.listenerStart = null;
    }
  }

  private async startListening(): Promise<void> {
    if (this.deps.listen) {
      await this.deps.listen();
      return;
    }
    const app = Fastify({ bodyLimit: 96 * 1024 * 1024 });

    // A phone can use this after the separate outbound privacy preflight.
    app.get("/pair/health", async () => ({ ok: true }));

    app.post("/pair/claim", async (request, reply) => {
      const body = (request.body ?? {}) as { code?: string };
      const entry = body.code ? this.pending.get(body.code) : undefined;
      if (!entry || entry.expiresAt < Date.now()) {
        return reply
          .status(410)
          .send({ error: "This code expired — scan a fresh QR." });
      }
      this.pending.delete(body.code as string);
      return reply.send(
        this.issueClaim({
          entry,
          host: request.headers.host,
          userAgent: request.headers["user-agent"],
        }),
      );
    });

    app.post("/pair/install", async (request, reply) => {
      const body = (request.body ?? {}) as { code?: string };
      const codeHash =
        typeof body.code === "string" ? hashToken(body.code) : "";
      const index = this.installs.findIndex(
        (install) =>
          install.codeHash === codeHash && install.expiresAt >= Date.now(),
      );
      if (index < 0) {
        return reply
          .status(410)
          .send({ error: "This install link expired. Scan a fresh QR." });
      }
      const [entry] = this.installs.splice(index, 1);
      if (
        !entry ||
        !this.devices.some((device) => device.id === entry.deviceId)
      ) {
        this.save();
        return reply.status(410).send({ error: "Pairing revoked" });
      }
      return reply.send(
        this.issueClaim({
          entry,
          host: request.headers.host,
          userAgent: request.headers["user-agent"],
        }),
      );
    });

    app.get("/manifest.webmanifest", async (request, reply) => {
      const query = request.query as { install?: string; launch?: string };
      const installCode =
        typeof query.install === "string" ? query.install : undefined;
      if (installCode && !this.installIsLive(installCode)) {
        return reply.status(410).send({ error: "Install expired" });
      }
      const file = path.join(this.pwaDist(), "manifest.webmanifest");
      const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
        string,
        unknown
      >;
      return reply
        .header("cache-control", "no-store")
        .type("application/manifest+json")
        .send(
          installCode
            ? {
                ...manifest,
                start_url: `/?install=${encodeURIComponent(installCode)}`,
              }
            : pwaManifestWithLaunch(manifest, query.launch),
        );
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
    try {
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
    } catch (error) {
      await app.close().catch(() => {});
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.listenerStart?.catch(() => {});
    await this.lanApp?.close();
    this.lanApp = null;
    this.listening = false;
  }

  private authorized(header: string | string[] | undefined): boolean {
    const raw = Array.isArray(header) ? header[0] : header;
    const match = raw ? /^Bearer\s+(\S+)$/i.exec(raw.trim()) : null;
    if (!match?.[1]) return false;
    const hash = hashToken(match[1]);
    const device = this.devices.find(
      (entry) =>
        entry.tokenHash === hash || entry.additionalTokenHashes?.includes(hash),
    );
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

  private issueClaim(input: {
    entry: {
      profileId: string;
      context?: PairingContext;
      deviceId?: string;
    };
    host: string | undefined;
    userAgent: string | string[] | undefined;
  }) {
    if (!input.host) throw new Error("Pairing request did not include a host");
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    let device = input.entry.deviceId
      ? this.devices.find((candidate) => candidate.id === input.entry.deviceId)
      : undefined;
    if (device) {
      device.additionalTokenHashes = [
        ...(device.additionalTokenHashes ?? []),
        tokenHash,
      ];
      if (device.label === "Device")
        device.label = deviceLabel(input.userAgent);
    } else if (!input.entry.deviceId) {
      device = {
        id: randomUUID(),
        tokenHash,
        profileId: input.entry.profileId,
        label: deviceLabel(input.userAgent),
        createdAt: new Date().toISOString(),
      };
      this.devices.push(device);
    } else {
      throw new Error("Paired device no longer exists");
    }
    const installCode = randomBytes(32).toString("base64url");
    this.installs = this.installs.filter(
      (install) => install.expiresAt > Date.now(),
    );
    this.installs.push({
      codeHash: hashToken(installCode),
      deviceId: device.id,
      profileId: input.entry.profileId,
      ...(input.entry.context ? { context: input.entry.context } : {}),
      expiresAt: Date.now() + INSTALL_CODE_TTL_MS,
    });
    this.save();
    // The phone talks to whichever address it scanned; build the API base
    // from the Host it actually used.
    return {
      version: 1,
      name: os.hostname(),
      server: `http://${input.host}/api`,
      token,
      installCode,
      remotes: this.remoteLinks(input.entry.profileId),
      ...(input.entry.context ? { context: input.entry.context } : {}),
    };
  }

  private installIsLive(code: string): boolean {
    const codeHash = hashToken(code);
    return this.installs.some(
      (install) =>
        install.codeHash === codeHash && install.expiresAt >= Date.now(),
    );
  }

  /**
   * Credential-free remote locators. The phone authenticates independently.
   */
  private remoteLinks(profileId: string) {
    const store = this.deps.profileConfig.forProfile(profileId).remoteProjects;
    const seen = new Set<string>();
    const links: Array<{
      server: string;
      project: string;
      name: string;
      /** The DESKTOP project this remote mirrors — the phone uses it to
       * offer the remote as the way in when this desktop is asleep. */
      localProjectId: string;
    }> = [];
    for (const localProjectId of Object.keys(store.list())) {
      const link = store.get(localProjectId);
      if (!link) continue;
      const key = `${link.serverUrl}:${link.remoteProjectId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({
        server: link.serverUrl,
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

  /** Refuse the flow before binding or minting a code when packaging is bad. */
  private assertPwaReady(): void {
    const dist = this.pwaDist();
    const index = path.join(dist, "index.html");
    if (!fs.existsSync(index)) {
      throw new Error(
        "The mobile app bundle is missing. Rebuild or reinstall Catamorphic, then try again.",
      );
    }
    const html = fs.readFileSync(index, "utf8");
    const references = Array.from(
      html.matchAll(/(?:src|href)=["']\/([^"'?#]+)["']/g),
      (match) => match[1],
    ).filter((reference): reference is string => reference !== undefined);
    const missing = references.find((reference) => {
      const resolved = path.resolve(dist, reference);
      const relative = path.relative(dist, resolved);
      return (
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        !fs.existsSync(resolved)
      );
    });
    if (missing) {
      throw new Error(
        `The mobile app bundle is incomplete. Rebuild or reinstall Catamorphic, then try again. Missing: /${missing}`,
      );
    }
  }

  private async requestLocalNetworkAccess(): Promise<void> {
    if ((this.deps.platform ?? process.platform) !== "darwin") return;
    try {
      await (
        this.deps.requestLocalNetworkAccess ?? triggerLocalNetworkAccess
      )();
      return;
    } catch {
      // Apple exposes denial for a specific connection, not as a general
      // permission query. The connected-UDP trigger retries while the
      // system prompt is open, then lands here for denial or no LAN route.
    }
    const device =
      (this.deps.platform ?? process.platform) === "darwin"
        ? "this Mac"
        : "this computer";
    throw new Error(
      `Catamorphic could not access ${device} on your local network. In System Settings > Privacy & Security > Local Network, allow Catamorphic, then try again.`,
    );
  }

  private load(): PairingFile {
    try {
      return JSON.parse(fs.readFileSync(this.deps.file, "utf8")) as PairingFile;
    } catch {
      return {};
    }
  }

  private save(): void {
    this.installs = this.installs.filter(
      (install) => install.expiresAt > Date.now(),
    );
    fs.mkdirSync(path.dirname(this.deps.file), { recursive: true });
    fs.writeFileSync(
      this.deps.file,
      `${JSON.stringify(
        {
          port: this.port,
          devices: this.devices,
          ...(this.installs.length > 0 ? { installs: this.installs } : {}),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }
}

/**
 * Apple's TN3179 explicit-alert pattern: connect UDP sockets to randomized
 * link-local peers. Connecting emits no packets, but it is an outbound local
 * network operation, unlike accepting connections on our HTTP listener.
 * Retry because macOS may reject the first operation while its prompt is open.
 */
async function triggerLocalNetworkAccess(): Promise<void> {
  const deadline = Date.now() + LOCAL_NETWORK_PROBE_TIMEOUT_MS;
  let lastError: unknown = new Error("No broadcast-capable interface");
  while (Date.now() < deadline) {
    const targets = localNetworkProbeTargets();
    if (targets.length === 0) throw lastError;
    const results = await Promise.allSettled(
      targets.map((target) => connectUdp(target)),
    );
    if (results.some((result) => result.status === "fulfilled")) return;
    lastError = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )?.reason;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError;
}

interface UdpTarget {
  family: "udp4" | "udp6";
  address: string;
}

function connectUdp({ family, address }: UdpTarget): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket(family);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(
      () => finish(new Error(`Local network check timed out for ${address}`)),
      1_500,
    );
    socket.once("error", finish);
    socket.connect(9, address, () => finish());
  });
}

function localNetworkProbeTargets(): UdpTarget[] {
  const targets: UdpTarget[] = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    if (!isPhysicalLanInterface(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family === "IPv6" && /^fe[89ab]/i.test(entry.address)) {
        targets.push({
          family: "udp6",
          address: `fe80::${randomIpv6Host()}%${name}`,
        });
      } else if (entry.family === "IPv4") {
        const peer = randomIpv4Peer(entry.address, entry.netmask);
        if (peer) targets.push({ family: "udp4", address: peer });
      }
    }
  }
  return targets;
}

function randomIpv6Host(): string {
  const bytes = randomBytes(8);
  return Array.from({ length: 4 }, (_, index) =>
    bytes.readUInt16BE(index * 2).toString(16),
  ).join(":");
}

function randomIpv4Peer(address: string, netmask: string): string | null {
  const ip = ipv4ToNumber(address);
  const mask = ipv4ToNumber(netmask);
  if (ip === null || mask === null) return null;
  const hostMask = ~mask >>> 0;
  if (hostMask < 3) return null;
  const network = (ip & mask) >>> 0;
  let host = randomBytes(4).readUInt32BE(0) & hostMask;
  if (host === 0 || host === hostMask) host = 1;
  const peer = (network | host) >>> 0;
  return numberToIpv4(peer === ip ? (network | 2) >>> 0 : peer);
}

function ipv4ToNumber(address: string): number | null {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return null;
  }
  return octets.reduce((value, octet) => (value << 8) | octet, 0) >>> 0;
}

function numberToIpv4(address: number): string {
  return [24, 16, 8, 0]
    .map((shift) => String((address >>> shift) & 0xff))
    .join(".");
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
  const ips = new Set<string>();
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    if (!isPhysicalLanInterface(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) ips.add(entry.address);
    }
  }
  return [...ips];
}

function isPhysicalLanInterface(name: string): boolean {
  if (process.platform === "darwin") return /^en\d+$/i.test(name);
  if (process.platform === "win32") return /wi-?fi|ethernet/i.test(name);
  return /^(?:en|eth|wl)/i.test(name);
}
