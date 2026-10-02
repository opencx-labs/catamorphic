// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonalEnvironmentView } from "../../shared/personal-environment.js";
import { RemoteEnvironmentModal } from "./remote-environment-modal.js";

const desktop = vi.hoisted(() => ({
  personalEnvironment: vi.fn(),
  personalEnvironmentSync: vi.fn(),
  personalEnvironmentAddFiles: vi.fn(),
  personalEnvironmentRemoveFile: vi.fn(),
  personalEnvironmentConfigFile: vi.fn(),
  onPersonalEnvironmentChanged: vi.fn(() => () => {}),
}));

vi.mock("../lib/desktop-api.js", () => ({ desktopApi: desktop }));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const roots: Root[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function view(
  overrides: Partial<PersonalEnvironmentView> = {},
): PersonalEnvironmentView {
  return {
    projectId: "project-1",
    configPath: ".work/personal/environment.json",
    configExists: true,
    configError: null,
    server: "allowed",
    files: [
      {
        path: "apps/api/.env.local",
        bytes: 2048,
        problem: null,
        server: { bytes: 2048, updatedAt: new Date().toISOString() },
      },
      {
        path: ".env",
        bytes: null,
        problem: "Not found in the project folder",
        server: null,
      },
    ],
    lastSyncAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    lastCheckedAt: new Date().toISOString(),
    error: null,
    syncing: false,
    ...overrides,
  };
}

async function render(
  props: { onOpenFile?: (path: string) => void; onClose?: () => void } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <RemoteEnvironmentModal
        open
        projectId="project-1"
        onClose={props.onClose ?? (() => {})}
        onOpenFile={props.onOpenFile ?? (() => {})}
      />,
    );
  });
}

const button = (text: string) =>
  Array.from(document.body.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );

describe("RemoteEnvironmentModal", () => {
  it("says where sign-ins run, and shows files with problems and the last send", async () => {
    desktop.personalEnvironment.mockResolvedValue(view());
    await render();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Remote environment");
    expect(
      document.body.querySelector('[data-testid="remote-environment-sign-ins"]')
        ?.textContent,
    ).toContain(
      "A chat that uses one runs only on a machine where you signed in to it yourself",
    );
    expect(text).toContain("apps/api/.env.local");
    expect(text).toContain("2 KB");
    expect(text).toContain("Not found in the project folder");
    expect(text).toContain("Sent 3m ago");
    expect(
      document.body.querySelector('[data-testid="remote-environment-server"]'),
    ).toBeNull();
    expect(document.body.querySelector('input[type="checkbox"]')).toBeNull();
    expect(text).not.toMatch(/[–—]/);
  });

  it("explains that nothing is sent until an Environment allows it", async () => {
    desktop.personalEnvironment.mockResolvedValue(
      view({ server: "not-allowed" }),
    );
    await render();
    expect(
      document.body.querySelector('[data-testid="remote-environment-server"]')
        ?.textContent,
    ).toContain('"personalCredentials": true');
  });

  it("edits the config through the desktop: files and removal", async () => {
    desktop.personalEnvironment.mockResolvedValue(view());
    desktop.personalEnvironmentAddFiles.mockResolvedValue(null);
    desktop.personalEnvironmentRemoveFile.mockResolvedValue(
      view({ files: [] }),
    );
    await render();

    await act(async () => button("Add files")?.click());
    expect(desktop.personalEnvironmentAddFiles).toHaveBeenCalledWith(
      "project-1",
    );

    const remove = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove apps/api/.env.local"]',
    );
    await act(async () => remove?.click());
    expect(desktop.personalEnvironmentRemoveFile).toHaveBeenCalledWith({
      projectId: "project-1",
      path: "apps/api/.env.local",
    });
    expect(document.body.textContent).toContain("No files yet");
  });

  it("opens the config file in the editor and closes", async () => {
    desktop.personalEnvironment.mockResolvedValue(
      view({ configExists: false }),
    );
    desktop.personalEnvironmentConfigFile.mockResolvedValue(
      ".work/personal/environment.json",
    );
    const onOpenFile = vi.fn();
    const onClose = vi.fn();
    await render({ onOpenFile, onClose });
    await act(async () => button("Edit config")?.click());
    expect(onOpenFile).toHaveBeenCalledWith(".work/personal/environment.json");
    expect(onClose).toHaveBeenCalled();
  });

  it("shows a broken config and keeps edits off until it is fixed", async () => {
    desktop.personalEnvironment.mockResolvedValue(
      view({ configError: 'Unknown key "file"; use "files"' }),
    );
    await render();
    expect(
      document.body.querySelector('[data-testid="remote-environment-status"]')
        ?.textContent,
    ).toContain('Unknown key "file"');
    expect(button("Add files")?.disabled).toBe(true);
    expect(button("Edit config")?.disabled).toBe(false);
  });

  it("sends now on request", async () => {
    desktop.personalEnvironment.mockResolvedValue(view({ lastSyncAt: null }));
    desktop.personalEnvironmentSync.mockResolvedValue(view());
    await render();
    await act(async () => button("Send now")?.click());
    expect(desktop.personalEnvironmentSync).toHaveBeenCalledWith("project-1");
    expect(document.body.textContent).toContain("Sent 3m ago");
  });
});
