import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * "Continue on mobile" end to end at the HTTP contract level: the app
 * mints a pairing, a "phone" (plain fetch) claims the code, and the
 * device token gates the LAN /api proxy onto the embedded server. The
 * PWA bundle is stubbed via CATAMORPHIC_PWA_DIST — its static serving is
 * asserted, its UI is covered by the PWA's own e2e.
 */

let app: AppHandle;
let stubDist: string;

beforeAll(async () => {
  stubDist = fs.mkdtempSync(path.join(os.tmpdir(), "pwa-dist-stub-"));
  fs.writeFileSync(
    path.join(stubDist, "index.html"),
    '<!doctype html><title>pwa-stub</title><link rel="manifest" href="/manifest.webmanifest">',
  );
  fs.writeFileSync(
    path.join(stubDist, "manifest.webmanifest"),
    JSON.stringify({
      name: "Catamorphic",
      start_url: "/",
      display: "standalone",
    }),
  );
  app = await launchApp({
    env: {
      CATAMORPHIC_E2E_MOBILE_PAIRING_ADDRESS: "127.0.0.1",
      CATAMORPHIC_PWA_DIST: stubDist,
    },
  });
}, 180_000);

afterAll(async () => {
  await app?.stop();
  fs.rmSync(stubDist, { recursive: true, force: true });
});

describe("continue on mobile", () => {
  let base: string;
  let code: string;
  let token: string;
  let installedToken: string;
  let installCode: string;
  let replacementInstallCode: string;
  let apiBase: string;

  it("mints a pairing QR payload with the chat context", async () => {
    const info = await app.eval<{
      url: string;
      expiresAt: string;
    }>(
      `window.catamorphicDesktop.mobilePairingStart({ projectId: "p-ctx", sessionId: "s-ctx" })`,
    );
    const url = new URL(info.url);
    code = url.searchParams.get("pair") ?? "";
    expect(code.length).toBeGreaterThan(10);
    // Reach the listener via loopback regardless of which LAN IP the QR
    // advertises — same machine, same port.
    base = `http://127.0.0.1:${url.port}`;
  });

  it("serves the PWA bundle at the listener root", async () => {
    const page = await fetch(`${base}/`).then((r) => r.text());
    expect(page).toContain("pwa-stub");
  });

  it("claims the code once: device token, context, host-based server", async () => {
    const claim = await fetch(`${base}/pair/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(claim.status).toBe(200);
    const body = (await claim.json()) as {
      token: string;
      installCode: string;
      server: string;
      context?: { projectId?: string; sessionId?: string };
      remotes: unknown[];
    };
    token = body.token;
    installCode = body.installCode;
    apiBase = body.server;
    expect(body.context).toEqual({ projectId: "p-ctx", sessionId: "s-ctx" });
    expect(body.server).toBe(`${base}/api`);
    expect(Array.isArray(body.remotes)).toBe(true);
    expect(installCode.length).toBeGreaterThan(10);

    const again = await fetch(`${base}/pair/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(again.status).toBe(410);
  });

  it("restores pairing when the installed app starts without browser storage", async () => {
    const manifest = await fetch(
      `${base}/manifest.webmanifest?install=${encodeURIComponent(installCode)}`,
    );
    expect(manifest.status).toBe(200);
    expect((await manifest.json()) as unknown).toMatchObject({
      start_url: `/?install=${encodeURIComponent(installCode)}`,
    });

    const remoteLaunch =
      "/?server=https%3A%2F%2Fexample.test%2Fapi&project=remote-1";
    const remoteManifest = await fetch(
      `${base}/manifest.webmanifest?launch=${encodeURIComponent(remoteLaunch)}`,
    );
    expect((await remoteManifest.json()) as unknown).toMatchObject({
      start_url: remoteLaunch,
    });

    const recovered = await fetch(`${base}/pair/install`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "iPhone installed app",
      },
      body: JSON.stringify({ code: installCode }),
    });
    expect(recovered.status).toBe(200);
    const body = (await recovered.json()) as {
      token: string;
      installCode: string;
      server: string;
      context?: { projectId?: string; sessionId?: string };
    };
    installedToken = body.token;
    replacementInstallCode = body.installCode;
    expect(body.server).toBe(`${base}/api`);
    expect(body.context).toEqual({ projectId: "p-ctx", sessionId: "s-ctx" });

    const again = await fetch(`${base}/pair/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: installCode }),
    });
    expect(again.status).toBe(410);
  });

  it("gates the /api proxy on the device token", async () => {
    const denied = await fetch(`${apiBase}/projects`);
    expect(denied.status).toBe(401);
    const allowed = await fetch(`${apiBase}/projects`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(allowed.status).toBe(200);
    const list = (await allowed.json()) as { items: unknown[] };
    expect(Array.isArray(list.items)).toBe(true);
    const installed = await fetch(`${apiBase}/projects`, {
      headers: { authorization: `Bearer ${installedToken}` },
    });
    expect(installed.status).toBe(200);
  });

  it("lists the paired device and revocation kills its token", async () => {
    const devices = await app.eval<
      Array<{ id: string; label: string; lastSeenAt: string | null }>
    >(`window.catamorphicDesktop.mobilePairingDevices()`);
    expect(devices).toHaveLength(1);
    expect(devices.every((device) => device.lastSeenAt)).toBe(true);
    for (const device of devices) {
      const revoked = await app.eval<boolean>(
        `window.catamorphicDesktop.mobilePairingRevoke(${JSON.stringify(device.id)})`,
      );
      expect(revoked).toBe(true);
    }
    const denied = await fetch(`${apiBase}/projects`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(denied.status).toBe(401);
    const installedDenied = await fetch(`${apiBase}/projects`, {
      headers: { authorization: `Bearer ${installedToken}` },
    });
    expect(installedDenied.status).toBe(401);
    expect(
      await app.eval<unknown[]>(
        `window.catamorphicDesktop.mobilePairingDevices()`,
      ),
    ).toHaveLength(0);
    const revokedInstall = await fetch(`${base}/pair/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: replacementInstallCode }),
    });
    expect(revokedInstall.status).toBe(410);
  });

  it("rejects garbage tokens and garbage codes", async () => {
    const bad = await fetch(`${apiBase}/projects`, {
      headers: { authorization: "Bearer nope" },
    });
    expect(bad.status).toBe(401);
    const badClaim = await fetch(`${base}/pair/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "nope" }),
    });
    expect(badClaim.status).toBe(410);
  });
});
