import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MobilePairingService } from "./mobile-pairing.js";
import { ProfileConfigManager } from "./profile-config.js";
import { ProfilesStore } from "./profiles.js";
import type { DataPaths } from "./server/paths.js";

const roots: string[] = [];
const services: MobilePairingService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeService({
  index,
  assets = {},
  listen,
  requestLocalNetworkAccess,
}: {
  index?: string;
  assets?: Record<string, string>;
  listen?: () => Promise<void>;
  requestLocalNetworkAccess?: () => Promise<void>;
}): MobilePairingService {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-pairing-"));
  roots.push(root);
  const dist = path.join(root, "pwa");
  fs.mkdirSync(dist, { recursive: true });
  if (index !== undefined)
    fs.writeFileSync(path.join(dist, "index.html"), index);
  for (const [relative, contents] of Object.entries(assets)) {
    const file = path.join(dist, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  const dataRoot = path.join(root, "data");
  const paths: DataPaths = {
    root: dataRoot,
    db: path.join(dataRoot, "db"),
    projects: path.join(dataRoot, "projects"),
    remotes: path.join(dataRoot, "remotes"),
    appBundles: path.join(dataRoot, "app-bundles"),
    settingsFile: path.join(root, "settings.json"),
    githubFile: path.join(root, "github.json"),
    keybindingsFile: path.join(root, "keybindings.json"),
    profilesFile: path.join(root, "profiles.json"),
    sidebarFile: path.join(root, "sidebar.js"),
    themeFile: path.join(root, "theme.json"),
    profilesDir: path.join(root, "profiles"),
    agentHomesDir: path.join(root, "agent-homes"),
    hostSkillsDir: path.join(root, "host-skills"),
  };
  const profileConfig = new ProfileConfigManager(
    paths,
    new ProfilesStore(paths.profilesFile),
  );
  const pairingFile = path.join(root, "mobile-pairing.json");
  fs.writeFileSync(pairingFile, '{"port":0}\n');
  const deps = {
    file: pairingFile,
    profileConfig,
    serverUrl: () => null,
    pwaDist: dist,
    lanAddresses: () => ["192.0.2.10", "192.0.2.11"],
    listen: listen ?? (async () => {}),
    platform: "darwin" as const,
    ...(requestLocalNetworkAccess ? { requestLocalNetworkAccess } : {}),
  };
  const service = new MobilePairingService(deps);
  services.push(service);
  return service;
}

describe("MobilePairingService readiness", () => {
  it("refuses to mint a QR when the PWA entry point is missing", async () => {
    const service = makeService({});

    await expect(service.createPairing("profile-1")).rejects.toThrow(
      "mobile app bundle is missing",
    );
  });

  it("refuses to mint a QR when the PWA entry point references a missing asset", async () => {
    const service = makeService({
      index: '<div id="root"></div><script src="/assets/app.js"></script>',
    });

    await expect(service.createPairing("profile-1")).rejects.toThrow(
      "mobile app bundle is incomplete",
    );
  });

  it("shows a descriptive error when local network access is unavailable", async () => {
    const service = makeService({
      index: '<div id="root"></div><script src="/assets/app.js"></script>',
      assets: { "assets/app.js": "document.body.dataset.ready = 'true';" },
      requestLocalNetworkAccess: async () => {
        throw new Error("local network denied");
      },
    });

    await expect(service.createPairing("profile-1")).rejects.toThrow(
      "System Settings > Privacy & Security > Local Network",
    );
  });

  it("runs the permission trigger before it mints a QR", async () => {
    let permissionRequested = false;
    const service = makeService({
      index: '<div id="root"></div><script src="/assets/app.js"></script>',
      assets: { "assets/app.js": "document.body.dataset.ready = 'true';" },
      requestLocalNetworkAccess: async () => {
        permissionRequested = true;
      },
    });

    const pairing = await service.createPairing("profile-1");

    expect(permissionRequested).toBe(true);
    expect(new URL(pairing.url).hostname).toBe("192.0.2.10");
    expect(pairing.alternates).toHaveLength(1);
  });

  it("serializes overlapping listener starts", async () => {
    let listenCount = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = makeService({
      index: '<div id="root"></div><script src="/assets/app.js"></script>',
      assets: { "assets/app.js": "document.body.dataset.ready = 'true';" },
      listen: async () => {
        listenCount += 1;
        await gate;
      },
    });

    const first = service.ensureListening();
    const second = service.ensureListening();
    await Promise.resolve();
    expect(listenCount).toBe(1);

    release?.();
    await Promise.all([first, second]);
    await service.ensureListening();
    expect(listenCount).toBe(1);
  });
});
