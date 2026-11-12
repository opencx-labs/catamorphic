import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const keychain = vi.hoisted(() => vi.fn(async () => "real-keychain-fixture"));
vi.mock("./harness-logins.js", () => ({ readClaudeKeychain: keychain }));

import { readAgentCredentials } from "./agent-credentials.js";
import { signInUsable } from "./auth-health.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  keychain.mockClear();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function places() {
  const homeDir = mkdtempSync(path.join(tmpdir(), "work-credential-test-"));
  roots.push(homeDir);
  return { homeDir, agentHomesDir: path.join(homeDir, "agents") };
}

it.each(["claude-code", "codex"] as const)(
  "fake %s tests never read machine sign-ins",
  async (harness) => {
    vi.stubEnv("CATAMORPHIC_E2E_FAKE_AGENT", "1");
    vi.stubEnv("CATAMORPHIC_E2E_AGENT_CREDENTIALS", "");
    const folders = places();
    const nativeHome = path.join(
      folders.homeDir,
      harness === "codex" ? ".codex" : ".claude",
    );
    mkdirSync(nativeHome);
    writeFileSync(
      path.join(
        nativeHome,
        harness === "codex" ? "auth.json" : ".credentials.json",
      ),
      "machine-sign-in",
    );
    const result = await readAgentCredentials(
      { harness, auth: "local", id: "agent" },
      folders,
    );
    expect(result.fingerprint).toBe("e2e-fake");
    expect(signInUsable({ harness, raw: result.raw, now: Date.now() })).toBe(
      true,
    );
    expect(result.raw).not.toContain("machine-sign-in");
    expect(keychain).not.toHaveBeenCalled();
  },
);

it("a missing fake sign-in fixture never falls back to the Keychain", async () => {
  vi.stubEnv("CATAMORPHIC_E2E_FAKE_AGENT", "1");
  const folders = places();
  vi.stubEnv(
    "CATAMORPHIC_E2E_AGENT_CREDENTIALS",
    path.join(folders.homeDir, "missing.json"),
  );
  expect(
    await readAgentCredentials(
      { harness: "claude-code", auth: "local", id: "agent" },
      folders,
    ),
  ).toEqual({ present: false, fingerprint: "absent", raw: null });
  expect(keychain).not.toHaveBeenCalled();
});

it("ordinary local sign-ins retain their Keychain lookup", async () => {
  vi.stubEnv("CATAMORPHIC_E2E_FAKE_AGENT", "0");
  const result = await readAgentCredentials(
    { harness: "claude-code", auth: "local", id: "agent" },
    places(),
  );
  expect(result.raw).toBe("real-keychain-fixture");
  expect(keychain).toHaveBeenCalledOnce();
});
