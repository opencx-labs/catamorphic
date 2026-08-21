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
    "<!doctype html><title>pwa-stub</title>",
  );
  app = await launchApp({ env: { CATAMORPHIC_PWA_DIST: stubDist } });
}, 180_000);

afterAll(async () => {
  await app?.stop();
  fs.rmSync(stubDist, { recursive: true, force: true });
});

describe("continue on mobile", () => {
  let base: string;
  let code: string;
  let token: string;
  let apiBase: string;

  it("mints a pairing QR payload with the chat context", async () => {
    const info = await app.eval<{
      url: string;
      expiresAt: string;
      pwaReady: boolean;
    }>(
      `window.catamorphicDesktop.mobilePairingStart({ projectId: "p-ctx", sessionId: "s-ctx" })`,
    );
    expect(info.pwaReady).toBe(true);
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
      server: string;
      context?: { projectId?: string; sessionId?: string };
      remotes: unknown[];
    };
    token = body.token;
    apiBase = body.server;
    expect(body.context).toEqual({ projectId: "p-ctx", sessionId: "s-ctx" });
    expect(body.server).toBe(`${base}/api`);
    expect(Array.isArray(body.remotes)).toBe(true);

    const again = await fetch(`${base}/pair/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
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
  });

  it("lists the paired device and revocation kills its token", async () => {
    const devices = await app.eval<
      Array<{ id: string; label: string; lastSeenAt: string | null }>
    >(`window.catamorphicDesktop.mobilePairingDevices()`);
    expect(devices).toHaveLength(1);
    expect(devices[0]?.lastSeenAt).toBeTruthy();
    const revoked = await app.eval<boolean>(
      `window.catamorphicDesktop.mobilePairingRevoke(${JSON.stringify(devices[0]?.id)})`,
    );
    expect(revoked).toBe(true);
    const denied = await fetch(`${apiBase}/projects`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(denied.status).toBe(401);
    expect(
      await app.eval<unknown[]>(
        `window.catamorphicDesktop.mobilePairingDevices()`,
      ),
    ).toHaveLength(0);
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
