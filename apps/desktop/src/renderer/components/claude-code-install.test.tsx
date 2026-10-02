// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClaudeCodeInstallStatus } from "../../shared/claude-code-install.js";
import { ClaudeCodeInstall } from "./claude-code-install";

const { status, update } = vi.hoisted(() => ({
  status: vi.fn(),
  update: vi.fn(),
}));
vi.mock("../lib/desktop-api", () => ({
  desktopApi: { claudeCodeStatus: status, claudeCodeUpdate: update },
}));

const installed = (version: string) => ({
  executablePath: `/Users/person/.local/share/claude/versions/${version}`,
  commandPath: "/Users/person/.local/bin/claude",
  version,
});
const old: ClaudeCodeInstallStatus = {
  using: "work",
  installed: installed("2.1.220"),
  minVersion: "2.1.287",
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  status.mockReset();
  update.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
});

const updateButton = () =>
  container.querySelector<HTMLButtonElement>(
    '[data-testid="claude-code-update"]',
  );

it("names the person's own install when it runs", async () => {
  status.mockResolvedValue({
    using: "installed",
    installed: installed("2.1.290"),
    minVersion: "2.1.287",
  });
  await act(async () => root.render(<ClaudeCodeInstall />));
  expect(container.textContent).toContain("Runs your Claude Code 2.1.290.");
  expect(updateButton()).toBeNull();
});

it("offers to update an old install and switches to it once updated", async () => {
  status.mockResolvedValue(old);
  update.mockResolvedValue({
    output: "Successfully updated",
    status: { ...old, using: "installed", installed: installed("2.1.287") },
  });
  await act(async () => root.render(<ClaudeCodeInstall />));
  expect(container.textContent).toContain(
    "Your Claude Code 2.1.220 is older than the 2.1.287 Work needs",
  );
  await act(async () => updateButton()?.click());
  expect(update).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("Runs your Claude Code 2.1.287.");
  expect(updateButton()).toBeNull();
});

it("says why an update did not take", async () => {
  status.mockResolvedValue(old);
  update.mockResolvedValue({
    output: "Checking for updates\nClaude Code is managed by Homebrew",
    status: old,
  });
  await act(async () => root.render(<ClaudeCodeInstall />));
  await act(async () => updateButton()?.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Claude Code did not update: Claude Code is managed by Homebrew",
  );
});

it("explains Work's copy when nothing is installed", async () => {
  status.mockResolvedValue({
    using: "work",
    installed: null,
    minVersion: "2.1.287",
  });
  await act(async () => root.render(<ClaudeCodeInstall />));
  expect(container.textContent).toContain(
    "Runs Work's Claude Code 2.1.287. Install Claude Code to use your own.",
  );
});

it("says when an update lands but is still too old", async () => {
  status.mockResolvedValue(old);
  update.mockResolvedValue({
    output: "Successfully updated to 2.1.250",
    status: { ...old, installed: installed("2.1.250") },
  });
  await act(async () => root.render(<ClaudeCodeInstall />));
  await act(async () => updateButton()?.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Claude Code updated to 2.1.250, which is still older than the 2.1.287 Work needs.",
  );
});
