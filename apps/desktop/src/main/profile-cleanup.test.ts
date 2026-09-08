import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ safeStorage: {} }));

import { ProfileConfigManager } from "./profile-config.js";
import { ProfilesStore } from "./profiles.js";
import type { DataPaths } from "./server/paths.js";

describe("profile resource ownership", () => {
  it("closes every watcher when profiles are removed, preserving the default", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cat-profile-cleanup-"));
    const profiles = new ProfilesStore(path.join(root, "profiles.json"));
    const config = new ProfileConfigManager(
      { profilesDir: path.join(root, "profiles") } as DataPaths,
      profiles,
    );
    const original = config.forDefaultProfile();
    try {
      for (let i = 0; i < 10; i++) {
        const profile = profiles.create(`Temporary ${i}`);
        const stores = config.forProfile(profile.id);
        const disposed = [
          stores.theme,
          stores.keybindings,
          stores.sidebar,
          stores.prefs,
        ].map((store) => vi.spyOn(store, "dispose"));
        expect(profiles.remove(profile.id)).toBe(true);
        expect(() => config.forProfile(profile.id)).toThrow("no longer exists");
        for (const dispose of disposed) expect(dispose).toHaveBeenCalledOnce();
      }
      expect(config.forDefaultProfile()).toBe(original);
      expect(Reflect.get(config, "stores").size).toBe(1);
    } finally {
      config.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
