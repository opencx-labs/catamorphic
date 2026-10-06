// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonalEnvironmentView } from "../../shared/personal-environment.js";
import type {
  CodexSignIn,
  RemoteMachine,
} from "../../shared/remote-machines.js";
import { CODEX_SIGN_IN_POLL_MS } from "./codex-sign-in-dialog.js";
import { RemoteEnvironmentModal } from "./remote-environment-modal.js";

const desktop = vi.hoisted(() => ({
  personalEnvironment: vi.fn(),
  personalEnvironmentSync: vi.fn(),
  personalEnvironmentAddFiles: vi.fn(),
  personalEnvironmentRemoveFile: vi.fn(),
  personalEnvironmentConfigFile: vi.fn(),
  onPersonalEnvironmentChanged: vi.fn(() => () => {}),
  remoteMachines: vi.fn(),
  remoteCodexSignIn: vi.fn(),
  remoteCodexSignInStatus: vi.fn(),
  remoteCodexSignInCancel: vi.fn(),
  remoteCodexSignOut: vi.fn(),
  openSignInLink: vi.fn(),
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
  vi.useRealTimers();
  vi.resetAllMocks();
  desktop.onPersonalEnvironmentChanged.mockImplementation(() => () => {});
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
    setup: null,
    lastSyncAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    lastCheckedAt: new Date().toISOString(),
    error: null,
    syncing: false,
    ...overrides,
  };
}

async function render(
  props: {
    onOpenFile?: (path: string) => void;
    onClose?: () => void;
    open?: boolean;
  } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const draw = async (open: boolean) => {
    await act(async () => {
      root.render(
        <RemoteEnvironmentModal
          open={open}
          projectId="project-1"
          onClose={props.onClose ?? (() => {})}
          onOpenFile={props.onOpenFile ?? (() => {})}
        />,
      );
    });
  };
  await draw(props.open ?? true);
  return { rerender: draw };
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
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(
      document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "")
        ?.textContent,
    ).toBe("Remote environment");
    expect(
      document.body.querySelector('[data-testid="remote-environment-sign-ins"]')
        ?.textContent,
    ).toContain(
      "Claude Code runs on your own subscription only on this computer. On the project's server, it runs through your organization's model connection.",
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

  it("shows the member's own setup command and whether the server has it", async () => {
    desktop.personalEnvironment.mockResolvedValue(
      view({
        setup: {
          command: "mise install && direnv allow",
          server: {
            updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          },
        },
      }),
    );
    await render();
    const section = document.body.querySelector(
      '[data-testid="remote-environment-setup"]',
    );
    expect(section?.querySelector("pre")?.textContent).toBe(
      "mise install && direnv allow",
    );
    expect(section?.textContent).toContain("On the server, sent 5m ago");
    expect(section?.textContent).not.toMatch(/[–—]/);
  });

  it("says a changed setup is not sent yet, and how to add one", async () => {
    desktop.personalEnvironment.mockResolvedValueOnce(
      view({ setup: { command: "make tools", server: null } }),
    );
    await render();
    expect(
      document.body.querySelector('[data-testid="remote-environment-setup"]')
        ?.textContent,
    ).toContain("Not sent yet");
    act(() => {
      for (const root of roots.splice(0)) root.unmount();
    });
    document.body.replaceChildren();
    desktop.personalEnvironment.mockResolvedValue(view());
    await render();
    const empty = document.body.querySelector(
      '[data-testid="remote-environment-setup"]',
    );
    expect(empty?.querySelector("pre")).toBeNull();
    expect(empty?.textContent).toContain("No setup command");
  });

  it("explains that nothing is sent until an Environment allows it", async () => {
    desktop.personalEnvironment.mockResolvedValue(
      view({
        server: "not-allowed",
        setup: { command: "make tools", server: null },
      }),
    );
    await render();
    expect(
      document.body.querySelector('[data-testid="remote-environment-server"]')
        ?.textContent,
    ).toContain('"personalCredentials": true');
    const setup = document.body.querySelector(
      '[data-testid="remote-environment-setup"]',
    )?.textContent;
    expect(setup).toContain(
      "Not sent: no Environment allows personal credentials",
    );
    expect(setup).not.toContain("Runs after");
  });

  it("says why a setup is not sent when the server cannot take it", async () => {
    for (const [server, reason] of [
      ["sign-in", "Not sent: sign in to the project's server again"],
      ["unreachable", "Not sent: the project's server could not be reached"],
      [
        "unsupported",
        "Not sent: the server does not support remote environments",
      ],
    ] as const) {
      desktop.personalEnvironment.mockResolvedValue(
        view({ server, setup: { command: "make tools", server: null } }),
      );
      await render();
      expect(
        document.body.querySelector('[data-testid="remote-environment-setup"]')
          ?.textContent,
      ).toContain(reason);
      act(() => {
        for (const root of roots.splice(0)) root.unmount();
      });
      document.body.replaceChildren();
    }
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

function machine(overrides: Partial<RemoteMachine> = {}): RemoteMachine {
  return {
    id: "m-1",
    name: "ada-devbox",
    available: true,
    codex: "signed-out",
    ...overrides,
  };
}

function codeFor(attempt: string, userCode = "ABCD-1E2F3"): CodexSignIn {
  return {
    attempt,
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

/** A promise the test settles when it chooses. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const machinesSection = () =>
  document.body.querySelector('[data-testid="remote-machines"]');
const machineRow = () =>
  document.body.querySelector('[data-testid="remote-machine"]');
const labelled = (label: string) =>
  document.body.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
/** The sign-in dialog's panel, open or leaving. */
const signInDialog = () =>
  document.body
    .querySelector('[data-testid="codex-sign-in"]')
    ?.closest<HTMLElement>('[role="dialog"]') ?? null;
const signInOpen = () => {
  const dialog = signInDialog();
  return dialog !== null && !dialog.parentElement?.hasAttribute("inert");
};
const inDialog = (text: string) =>
  Array.from(signInDialog()?.querySelectorAll("button") ?? []).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
const code = () =>
  signInDialog()?.querySelector('[data-testid="codex-sign-in-code"]') ?? null;
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe("RemoteEnvironmentModal: your machines", () => {
  it("hides the machines on a server without them", async () => {
    desktop.personalEnvironment.mockResolvedValue(view());
    desktop.remoteMachines.mockResolvedValue(null);
    await render();
    expect(desktop.remoteMachines).toHaveBeenCalledWith("project-1");
    expect(machinesSection()).toBeNull();
    expect(document.body.textContent).not.toContain("Your machines");
  });

  it("says how to get a machine when the member has none", async () => {
    desktop.personalEnvironment.mockResolvedValue(view());
    desktop.remoteMachines.mockResolvedValue([]);
    await render();
    const text = machinesSection()?.textContent ?? "";
    expect(text).toContain("Your machines");
    expect(text).toContain(
      "Codex sign-ins need a machine of your own: ask an administrator for one. Codex on this computer uses this computer's sign-in.",
    );
    expect(machineRow()).toBeNull();
  });

  it("shows each machine online or offline, and signed in to Codex or not", async () => {
    desktop.personalEnvironment.mockResolvedValue(view());
    desktop.remoteMachines.mockResolvedValue([
      machine(),
      machine({ id: "m-2", name: "ada-gpu", codex: "signed-in" }),
      machine({ id: "m-3", name: "ada-old", available: false }),
    ]);
    await render();
    const rows = Array.from(
      document.body.querySelectorAll('[data-testid="remote-machine"]'),
      (row) => row.textContent,
    );
    expect(rows[0]).toContain("Online · Codex not signed in");
    expect(rows[1]).toContain("Online · Codex signed in");
    expect(rows[2]).toContain("Offline · Codex not signed in");
    expect(labelled("Sign in to Codex on ada-devbox")?.disabled).toBe(false);
    expect(labelled("Sign out of Codex on ada-gpu")).not.toBeNull();
    const offline = labelled("Sign in to Codex on ada-old");
    expect(offline?.disabled).toBe(true);
    expect(offline?.dataset.disabledReason).toBe("This machine is offline");
    expect(machinesSection()?.textContent).not.toMatch(/[–—]/);
  });

  it("says when the list fails, and lists again on request", async () => {
    desktop.personalEnvironment.mockResolvedValue(view());
    desktop.remoteMachines
      .mockRejectedValueOnce(new Error("The machine directory is down."))
      .mockResolvedValueOnce([machine()]);
    await render();
    expect(machinesSection()?.textContent).toContain(
      "Your machines could not be listed. The machine directory is down.",
    );
    await act(async () => button("Try again")?.click());
    expect(desktop.remoteMachines).toHaveBeenCalledTimes(2);
    expect(machineRow()?.textContent).toContain("ada-devbox");
  });

  it("signs in to Codex: the link, the code, and a check every 2 seconds until it is done", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    desktop.personalEnvironment.mockResolvedValue(view());
    desktop.remoteMachines.mockResolvedValue([machine()]);
    desktop.remoteCodexSignIn.mockResolvedValue(codeFor("att-1"));
    desktop.remoteCodexSignInStatus
      .mockResolvedValueOnce({ state: "waiting" })
      .mockResolvedValueOnce({ state: "signed-in" });
    desktop.openSignInLink.mockResolvedValue(undefined);
    await render();

    await act(async () => labelled("Sign in to Codex on ada-devbox")?.click());
    expect(desktop.remoteCodexSignIn).toHaveBeenCalledWith({
      projectId: "project-1",
      machineId: "m-1",
    });
    expect(signInOpen()).toBe(true);
    const dialog = signInDialog();
    expect(
      document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "")
        ?.textContent,
    ).toBe("Sign in to Codex on ada-devbox");
    const text = dialog?.textContent ?? "";
    expect(text).toContain("https://auth.openai.com/codex/device");
    expect(text).toContain("Expires in 15 minutes");
    expect(text).toContain(
      "If ChatGPT says device code sign-in is off, turn it on in ChatGPT under Settings, Security.",
    );
    expect(text).not.toMatch(/[–—]/);
    // Large and monospace on screen, one character at a time when read.
    expect(code()?.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      "ABCD-1E2F3",
    );
    expect(code()?.querySelector(".sr-only")?.textContent).toBe(
      "A B C D dash 1 E 2 F 3",
    );
    expect(labelled("Copy the code")).not.toBeNull();
    // Keyboard focus lands on the first step.
    expect(document.activeElement?.textContent?.trim()).toBe(
      "Open sign-in page",
    );

    await act(async () => inDialog("Open sign-in page")?.click());
    expect(desktop.openSignInLink).toHaveBeenCalledWith(
      "https://auth.openai.com/codex/device",
    );

    await advance(CODEX_SIGN_IN_POLL_MS - 1);
    expect(desktop.remoteCodexSignInStatus).not.toHaveBeenCalled();
    await advance(1);
    expect(desktop.remoteCodexSignInStatus).toHaveBeenCalledWith({
      projectId: "project-1",
      machineId: "m-1",
      attempt: "att-1",
    });
    expect(signInDialog()?.textContent).toContain(
      "Waiting for you to enter the code",
    );
    await advance(CODEX_SIGN_IN_POLL_MS);
    expect(desktop.remoteCodexSignInStatus).toHaveBeenCalledTimes(2);
    expect(signInDialog()?.textContent).toContain(
      "Codex is signed in on ada-devbox.",
    );
    expect(machineRow()?.textContent).toContain("Codex signed in");
    expect(labelled("Sign out of Codex on ada-devbox")).not.toBeNull();

    // Done: nothing left to cancel, and nothing more to ask.
    await act(async () => inDialog("Done")?.click());
    expect(signInOpen()).toBe(false);
    await advance(CODEX_SIGN_IN_POLL_MS * 5);
    expect(desktop.remoteCodexSignInStatus).toHaveBeenCalledTimes(2);
    expect(desktop.remoteCodexSignInCancel).not.toHaveBeenCalled();
  });

  it("keeps checking through a failed check", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    desktop.personalEnvironment.mockResolvedValue(view());
    desktop.remoteMachines.mockResolvedValue([machine()]);
    desktop.remoteCodexSignIn.mockResolvedValue(codeFor("att-1"));
    desktop.remoteCodexSignInStatus
      .mockRejectedValueOnce(
        new Error("The project's server could not be reached."),
      )
      .mockResolvedValueOnce({ state: "signed-in" });
    await render();
    await act(async () => labelled("Sign in to Codex on ada-devbox")?.click());
    await advance(CODEX_SIGN_IN_POLL_MS);
    expect(signInDialog()?.textContent).toContain(
      "Could not check the sign-in: The project's server could not be reached.",
    );
    await advance(CODEX_SIGN_IN_POLL_MS);
    expect(signInDialog()?.textContent).toContain(
      "Codex is signed in on ada-devbox.",
    );
  });

  it("shows why a sign-in ended, and tries again with a new code", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    desktop.personalEnvironment.mockResolvedValue(view());
    desktop.remoteMachines.mockResolvedValue([machine()]);
    // The machine refused the login (409 sign_in_refused): its words, as
    // written, with a way to try again.
    const refused =
      "Another person's Codex sign-in is on this machine, and a machine holds one person's only. Ask an administrator for a machine of your own";
    desktop.remoteCodexSignIn
      .mockRejectedValueOnce(new Error(refused))
      .mockResolvedValueOnce(codeFor("att-2"))
      .mockResolvedValueOnce(codeFor("att-3", "WXYZ-9K8L7"));
    desktop.remoteCodexSignInStatus
      .mockResolvedValueOnce({
        state: "failed",
        message: "Codex exited before the code was entered.",
      })
      .mockResolvedValueOnce({ state: "expired" });
    await render();

    await act(async () => labelled("Sign in to Codex on ada-devbox")?.click());
    expect(signInDialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      refused,
    );
    expect(code()).toBeNull();
    expect(document.activeElement?.textContent?.trim()).toBe("Try again");

    await act(async () => inDialog("Try again")?.click());
    expect(code()?.textContent).toContain("ABCD-1E2F3");
    await advance(CODEX_SIGN_IN_POLL_MS);
    expect(signInDialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "Codex exited before the code was entered.",
    );
    expect(code()).toBeNull();

    await act(async () => inDialog("Try again")?.click());
    expect(code()?.textContent).toContain("WXYZ-9K8L7");
    await advance(CODEX_SIGN_IN_POLL_MS);
    expect(signInDialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "The code expired before it was entered.",
    );
    expect(desktop.remoteCodexSignIn).toHaveBeenCalledTimes(3);
    // An attempt that ended needs no cancel when the dialog closes.
    await act(async () => inDialog("Close")?.click());
    expect(signInOpen()).toBe(false);
    expect(desktop.remoteCodexSignInCancel).not.toHaveBeenCalled();
    expect(machineRow()?.textContent).toContain("Codex not signed in");
  });

  it("cancels a waiting sign-in when the dialog closes, and stops checking", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    desktop.personalEnvironment.mockResolvedValue(view());
    desktop.remoteMachines.mockResolvedValue([machine()]);
    desktop.remoteCodexSignIn.mockResolvedValue(codeFor("att-1"));
    desktop.remoteCodexSignInStatus.mockResolvedValue({ state: "waiting" });
    desktop.remoteCodexSignInCancel.mockResolvedValue(undefined);
    await render();

    await act(async () => labelled("Sign in to Codex on ada-devbox")?.click());
    await advance(CODEX_SIGN_IN_POLL_MS);
    expect(desktop.remoteCodexSignInStatus).toHaveBeenCalledTimes(1);
    await act(async () => inDialog("Cancel")?.click());
    expect(signInOpen()).toBe(false);
    expect(desktop.remoteCodexSignInCancel).toHaveBeenCalledWith({
      projectId: "project-1",
      machineId: "m-1",
      attempt: "att-1",
    });
    await advance(CODEX_SIGN_IN_POLL_MS * 5);
    expect(desktop.remoteCodexSignInStatus).toHaveBeenCalledTimes(1);

    // Escape closes the sign-in, not the environment under it.
    desktop.remoteCodexSignIn.mockResolvedValue(codeFor("att-2"));
    await act(async () => labelled("Sign in to Codex on ada-devbox")?.click());
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(signInOpen()).toBe(false);
    expect(desktop.remoteCodexSignInCancel).toHaveBeenLastCalledWith({
      projectId: "project-1",
      machineId: "m-1",
      attempt: "att-2",
    });
    expect(document.body.textContent).toContain("Remote environment");
  });

  it("ignores answers to a sign-in closed or replaced since", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    desktop.personalEnvironment.mockResolvedValue(view());
    desktop.remoteMachines.mockResolvedValue([machine()]);
    desktop.remoteCodexSignInCancel.mockResolvedValue(undefined);
    const first = deferred<CodexSignIn>();
    desktop.remoteCodexSignIn
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(codeFor("att-2", "WXYZ-9K8L7"));
    const check = deferred<{ state: "signed-in" }>();
    desktop.remoteCodexSignInStatus.mockReturnValueOnce(check.promise);
    await render();

    // Closed while the machine was still starting, then started again.
    await act(async () => labelled("Sign in to Codex on ada-devbox")?.click());
    expect(signInDialog()?.textContent).toContain(
      "Asking ada-devbox for a code",
    );
    await act(async () => inDialog("Cancel")?.click());
    expect(desktop.remoteCodexSignInCancel).not.toHaveBeenCalled();
    await act(async () => labelled("Sign in to Codex on ada-devbox")?.click());
    expect(code()?.textContent).toContain("WXYZ-9K8L7");

    // The first answer arrives late: its code is cancelled, never shown.
    await act(async () => first.resolve(codeFor("att-1")));
    expect(desktop.remoteCodexSignInCancel).toHaveBeenCalledWith({
      projectId: "project-1",
      machineId: "m-1",
      attempt: "att-1",
    });
    expect(code()?.textContent).toContain("WXYZ-9K8L7");

    // A check still travelling when the dialog closes changes nothing.
    await advance(CODEX_SIGN_IN_POLL_MS);
    expect(desktop.remoteCodexSignInStatus).toHaveBeenCalledTimes(1);
    await act(async () => inDialog("Cancel")?.click());
    await act(async () => check.resolve({ state: "signed-in" }));
    expect(signInDialog()?.textContent).not.toContain("Codex is signed in");
    expect(machineRow()?.textContent).toContain("Codex not signed in");
    await advance(CODEX_SIGN_IN_POLL_MS * 3);
    expect(desktop.remoteCodexSignInStatus).toHaveBeenCalledTimes(1);
  });

  it("cancels a waiting sign-in when the environment closes", async () => {
    desktop.personalEnvironment.mockResolvedValue(view());
    desktop.remoteMachines.mockResolvedValue([machine()]);
    desktop.remoteCodexSignIn.mockResolvedValue(codeFor("att-1"));
    desktop.remoteCodexSignInCancel.mockResolvedValue(undefined);
    const { rerender } = await render();
    await act(async () => labelled("Sign in to Codex on ada-devbox")?.click());
    await rerender(false);
    expect(desktop.remoteCodexSignInCancel).toHaveBeenCalledWith({
      projectId: "project-1",
      machineId: "m-1",
      attempt: "att-1",
    });
    expect(signInOpen()).toBe(false);
  });

  it("signs out of Codex after asking in place", async () => {
    desktop.personalEnvironment.mockResolvedValue(view());
    desktop.remoteMachines.mockResolvedValue([machine({ codex: "signed-in" })]);
    desktop.remoteCodexSignOut
      .mockRejectedValueOnce(new Error("ada-devbox is not connected."))
      .mockResolvedValueOnce({ signedOut: true });
    await render();

    await act(async () => labelled("Sign out of Codex on ada-devbox")?.click());
    expect(machineRow()?.textContent).toContain(
      "Sign out of Codex on ada-devbox? Codex chats there need you to sign in again.",
    );
    expect(document.activeElement?.textContent?.trim()).toBe("Cancel");
    expect(desktop.remoteCodexSignOut).not.toHaveBeenCalled();
    await act(async () => button("Cancel")?.click());
    expect(document.activeElement).toBe(
      labelled("Sign out of Codex on ada-devbox"),
    );

    await act(async () => labelled("Sign out of Codex on ada-devbox")?.click());
    await act(async () => button("Sign out")?.click());
    expect(desktop.remoteCodexSignOut).toHaveBeenCalledWith({
      projectId: "project-1",
      machineId: "m-1",
    });
    expect(
      document.body.querySelector('[data-testid="remote-environment-status"]')
        ?.textContent,
    ).toBe("ada-devbox is not connected.");
    // Still asking: the person can try again.
    await act(async () => button("Sign out")?.click());
    expect(machineRow()?.textContent).toContain("Codex not signed in");
    expect(document.activeElement).toBe(
      labelled("Sign in to Codex on ada-devbox"),
    );
  });
});
