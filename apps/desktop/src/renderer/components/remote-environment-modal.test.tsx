// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonalEnvironmentView } from "../../shared/personal-environment.js";
import type {
  HarnessSignIn,
  RemoteMachine,
  RemoteSignInState,
} from "../../shared/remote-machines.js";
import { HARNESS_SIGN_IN_POLL_MS } from "./harness-sign-in-dialog.js";
import { RemoteEnvironmentModal } from "./remote-environment-modal.js";

const desktop = vi.hoisted(() => ({
  personalEnvironment: vi.fn(),
  personalEnvironmentSync: vi.fn(),
  personalEnvironmentAddFiles: vi.fn(),
  personalEnvironmentRemoveFile: vi.fn(),
  personalEnvironmentConfigFile: vi.fn(),
  onPersonalEnvironmentChanged: vi.fn(() => () => {}),
  remoteMachines: vi.fn(),
  remoteHarnessSignIn: vi.fn(),
  remoteHarnessSignInStatus: vi.fn(),
  remoteHarnessSignInCode: vi.fn(),
  remoteHarnessSignInCancel: vi.fn(),
  remoteHarnessSignOut: vi.fn(),
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
      "Claude Code and Codex can run on your own subscriptions on a machine of your own. Each signs in on the machine itself, so your sign-in stays there.",
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

function machine(
  overrides: Partial<Omit<RemoteMachine, "signIns">> & {
    codex?: RemoteSignInState;
    claude?: RemoteSignInState;
  } = {},
): RemoteMachine {
  const { codex, claude, ...rest } = overrides;
  return {
    id: "m-1",
    name: "ada-devbox",
    available: true,
    signIns: {
      "claude-code": claude ?? "signed-out",
      codex: codex ?? "signed-out",
    },
    ...rest,
  };
}

/** A Claude Code sign-in: a link, and a code the page gives back. */
const CLAUDE_LINK =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code";
function linkFor(attempt: string): HarnessSignIn {
  return {
    attempt,
    verificationUrl: CLAUDE_LINK,
    expects: "code",
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

function typeInto(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

/** One harness's row on the first machine. */
const signInRow = (harness: "claude-code" | "codex") =>
  document.body.querySelector(
    `[data-testid="remote-machine-sign-in"][data-harness="${harness}"]`,
  );
/** Where a person pastes the code a sign-in page gave them. */
const codeField = () =>
  signInDialog()?.querySelector<HTMLInputElement>('input[type="password"]') ??
  null;

function codeFor(attempt: string, userCode = "ABCD-1E2F3"): HarnessSignIn {
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
    .querySelector('[data-testid="harness-sign-in"]')
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
  signInDialog()?.querySelector('[data-testid="harness-sign-in-code"]') ?? null;
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
      "Sign-ins need a machine of your own: ask an administrator for one. Claude Code and Codex on this computer use this computer's sign-ins.",
    );
    expect(machineRow()).toBeNull();
  });

  it("shows each machine online or offline, and signed in to each harness or not", async () => {
    desktop.personalEnvironment.mockResolvedValue(view());
    desktop.remoteMachines.mockResolvedValue([
      machine(),
      machine({ id: "m-2", name: "ada-gpu", codex: "signed-in" }),
      machine({ id: "m-3", name: "ada-old", available: false }),
      machine({
        id: "m-4",
        name: "ada-both",
        codex: "signed-in",
        claude: "signed-in",
      }),
    ]);
    await render();
    const rows = Array.from(
      document.body.querySelectorAll('[data-testid="remote-machine"]'),
      (row) => row.textContent ?? "",
    );
    expect(rows[0]).toContain("ada-devboxOnline");
    expect(rows[0]).toContain("Claude Code not signed in");
    expect(rows[0]).toContain("Codex not signed in");
    expect(rows[1]).toContain("Online");
    expect(rows[1]).toContain("Claude Code not signed in");
    expect(rows[1]).toContain("Codex signed in");
    expect(rows[2]).toContain("ada-oldOffline");
    expect(rows[2]).toContain("Codex not signed in");
    expect(rows[3]).toContain("Claude Code signed in");
    expect(rows[3]).toContain("Codex signed in");
    // A row for each harness on each machine, Claude Code first.
    expect(
      Array.from(
        document.body.querySelectorAll<HTMLElement>(
          '[data-testid="remote-machine-sign-in"]',
        ),
        (row) => row.dataset.harness,
      ).slice(0, 2),
    ).toEqual(["claude-code", "codex"]);
    expect(labelled("Sign in to Codex on ada-devbox")?.disabled).toBe(false);
    expect(labelled("Sign in to Claude Code on ada-devbox")?.disabled).toBe(
      false,
    );
    expect(labelled("Sign out of Codex on ada-gpu")).not.toBeNull();
    expect(labelled("Sign in to Claude Code on ada-gpu")).not.toBeNull();
    expect(labelled("Sign out of Claude Code on ada-both")).not.toBeNull();
    for (const name of ["Codex", "Claude Code"]) {
      const offline = labelled(`Sign in to ${name} on ada-old`);
      expect(offline?.disabled).toBe(true);
      expect(offline?.dataset.disabledReason).toBe("This machine is offline");
    }
    const section = document.body.querySelector(
      '[data-testid="remote-environment-sign-ins"]',
    );
    expect(section?.textContent).toContain(
      "Claude Code and Codex can run on your own subscriptions on a machine of your own.",
    );
    // Nothing says Claude subscriptions stay on this computer any more.
    expect(section?.textContent).not.toContain("only on this computer");
    expect(section?.textContent).not.toMatch(/[–—]/);
  });

  it("shows when a member's worker is stopped or resuming", async () => {
    desktop.personalEnvironment.mockResolvedValue(view());
    desktop.remoteMachines.mockResolvedValue([
      machine({ name: "ada-parked", available: false, state: "stopped" }),
      machine({
        id: "m-2",
        name: "ada-starting",
        available: false,
        state: "resuming",
      }),
    ]);
    await render();
    expect(document.body.textContent).toContain("ada-parkedStopped");
    expect(document.body.textContent).toContain("ada-startingResuming");
    expect(
      labelled("Sign in to Codex on ada-parked")?.dataset.disabledReason,
    ).toBe("This machine is stopped");
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
    desktop.remoteHarnessSignIn.mockResolvedValue(codeFor("att-1"));
    desktop.remoteHarnessSignInStatus
      .mockResolvedValueOnce({ state: "waiting" })
      .mockResolvedValueOnce({ state: "signed-in" });
    desktop.openSignInLink.mockResolvedValue(undefined);
    await render();

    await act(async () => labelled("Sign in to Codex on ada-devbox")?.click());
    expect(desktop.remoteHarnessSignIn).toHaveBeenCalledWith({
      projectId: "project-1",
      machineId: "m-1",
      harness: "codex",
    });
    expect(signInOpen()).toBe(true);
    const dialog = signInDialog();
    expect(
      document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "")
        ?.textContent,
    ).toBe("Sign in to Codex on ada-devbox");
    const text = dialog?.textContent ?? "";
    // Short enough to read and type on another device.
    expect(text).toContain("auth.openai.com/codex/device");
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

    await advance(HARNESS_SIGN_IN_POLL_MS - 1);
    expect(desktop.remoteHarnessSignInStatus).not.toHaveBeenCalled();
    await advance(1);
    expect(desktop.remoteHarnessSignInStatus).toHaveBeenCalledWith({
      projectId: "project-1",
      machineId: "m-1",
      harness: "codex",
      attempt: "att-1",
    });
    expect(signInDialog()?.textContent).toContain(
      "Waiting for you to enter the code",
    );
    await advance(HARNESS_SIGN_IN_POLL_MS);
    expect(desktop.remoteHarnessSignInStatus).toHaveBeenCalledTimes(2);
    expect(signInDialog()?.textContent).toContain(
      "Codex is signed in on ada-devbox.",
    );
    expect(machineRow()?.textContent).toContain("Codex signed in");
    expect(labelled("Sign out of Codex on ada-devbox")).not.toBeNull();

    // Done: nothing left to cancel, and nothing more to ask.
    await act(async () => inDialog("Done")?.click());
    expect(signInOpen()).toBe(false);
    await advance(HARNESS_SIGN_IN_POLL_MS * 5);
    expect(desktop.remoteHarnessSignInStatus).toHaveBeenCalledTimes(2);
    expect(desktop.remoteHarnessSignInCancel).not.toHaveBeenCalled();
  });

  it("keeps checking through a failed check", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    desktop.personalEnvironment.mockResolvedValue(view());
    desktop.remoteMachines.mockResolvedValue([machine()]);
    desktop.remoteHarnessSignIn.mockResolvedValue(codeFor("att-1"));
    desktop.remoteHarnessSignInStatus
      .mockRejectedValueOnce(
        new Error("The project's server could not be reached."),
      )
      .mockResolvedValueOnce({ state: "signed-in" });
    await render();
    await act(async () => labelled("Sign in to Codex on ada-devbox")?.click());
    await advance(HARNESS_SIGN_IN_POLL_MS);
    expect(signInDialog()?.textContent).toContain(
      "Could not check the sign-in: The project's server could not be reached.",
    );
    await advance(HARNESS_SIGN_IN_POLL_MS);
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
      "Another person's sign-in is on this machine, and a machine holds one person's only. Ask an administrator for a machine of your own";
    desktop.remoteHarnessSignIn
      .mockRejectedValueOnce(new Error(refused))
      .mockResolvedValueOnce(codeFor("att-2"))
      .mockResolvedValueOnce(codeFor("att-3", "WXYZ-9K8L7"));
    desktop.remoteHarnessSignInStatus
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
    await advance(HARNESS_SIGN_IN_POLL_MS);
    expect(signInDialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "Codex exited before the code was entered.",
    );
    expect(code()).toBeNull();

    await act(async () => inDialog("Try again")?.click());
    expect(code()?.textContent).toContain("WXYZ-9K8L7");
    await advance(HARNESS_SIGN_IN_POLL_MS);
    expect(signInDialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "The code expired before it was entered.",
    );
    expect(desktop.remoteHarnessSignIn).toHaveBeenCalledTimes(3);
    // An attempt that ended needs no cancel when the dialog closes.
    await act(async () => inDialog("Close")?.click());
    expect(signInOpen()).toBe(false);
    expect(desktop.remoteHarnessSignInCancel).not.toHaveBeenCalled();
    expect(machineRow()?.textContent).toContain("Codex not signed in");
  });

  it("cancels a waiting sign-in when the dialog closes, and stops checking", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    desktop.personalEnvironment.mockResolvedValue(view());
    desktop.remoteMachines.mockResolvedValue([machine()]);
    desktop.remoteHarnessSignIn.mockResolvedValue(codeFor("att-1"));
    desktop.remoteHarnessSignInStatus.mockResolvedValue({ state: "waiting" });
    desktop.remoteHarnessSignInCancel.mockResolvedValue(undefined);
    await render();

    await act(async () => labelled("Sign in to Codex on ada-devbox")?.click());
    await advance(HARNESS_SIGN_IN_POLL_MS);
    expect(desktop.remoteHarnessSignInStatus).toHaveBeenCalledTimes(1);
    await act(async () => inDialog("Cancel")?.click());
    expect(signInOpen()).toBe(false);
    expect(desktop.remoteHarnessSignInCancel).toHaveBeenCalledWith({
      projectId: "project-1",
      machineId: "m-1",
      harness: "codex",
      attempt: "att-1",
    });
    await advance(HARNESS_SIGN_IN_POLL_MS * 5);
    expect(desktop.remoteHarnessSignInStatus).toHaveBeenCalledTimes(1);

    // Escape closes the sign-in, not the environment under it.
    desktop.remoteHarnessSignIn.mockResolvedValue(codeFor("att-2"));
    await act(async () => labelled("Sign in to Codex on ada-devbox")?.click());
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(signInOpen()).toBe(false);
    expect(desktop.remoteHarnessSignInCancel).toHaveBeenLastCalledWith({
      projectId: "project-1",
      machineId: "m-1",
      harness: "codex",
      attempt: "att-2",
    });
    expect(document.body.textContent).toContain("Remote environment");
  });

  it("ignores answers to a sign-in closed or replaced since", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    desktop.personalEnvironment.mockResolvedValue(view());
    desktop.remoteMachines.mockResolvedValue([machine()]);
    desktop.remoteHarnessSignInCancel.mockResolvedValue(undefined);
    const first = deferred<HarnessSignIn>();
    desktop.remoteHarnessSignIn
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(codeFor("att-2", "WXYZ-9K8L7"));
    const check = deferred<{ state: "signed-in" }>();
    desktop.remoteHarnessSignInStatus.mockReturnValueOnce(check.promise);
    await render();

    // Closed while the machine was still starting, then started again.
    await act(async () => labelled("Sign in to Codex on ada-devbox")?.click());
    expect(signInDialog()?.textContent).toContain(
      "Asking ada-devbox for a sign-in link",
    );
    await act(async () => inDialog("Cancel")?.click());
    expect(desktop.remoteHarnessSignInCancel).not.toHaveBeenCalled();
    await act(async () => labelled("Sign in to Codex on ada-devbox")?.click());
    expect(code()?.textContent).toContain("WXYZ-9K8L7");

    // The first answer arrives late: its code is cancelled, never shown.
    await act(async () => first.resolve(codeFor("att-1")));
    expect(desktop.remoteHarnessSignInCancel).toHaveBeenCalledWith({
      projectId: "project-1",
      machineId: "m-1",
      harness: "codex",
      attempt: "att-1",
    });
    expect(code()?.textContent).toContain("WXYZ-9K8L7");

    // A check still travelling when the dialog closes changes nothing.
    await advance(HARNESS_SIGN_IN_POLL_MS);
    expect(desktop.remoteHarnessSignInStatus).toHaveBeenCalledTimes(1);
    await act(async () => inDialog("Cancel")?.click());
    await act(async () => check.resolve({ state: "signed-in" }));
    expect(signInDialog()?.textContent).not.toContain("Codex is signed in");
    expect(machineRow()?.textContent).toContain("Codex not signed in");
    await advance(HARNESS_SIGN_IN_POLL_MS * 3);
    expect(desktop.remoteHarnessSignInStatus).toHaveBeenCalledTimes(1);
  });

  it("cancels a waiting sign-in when the environment closes", async () => {
    desktop.personalEnvironment.mockResolvedValue(view());
    desktop.remoteMachines.mockResolvedValue([machine()]);
    desktop.remoteHarnessSignIn.mockResolvedValue(codeFor("att-1"));
    desktop.remoteHarnessSignInCancel.mockResolvedValue(undefined);
    const { rerender } = await render();
    await act(async () => labelled("Sign in to Codex on ada-devbox")?.click());
    await rerender(false);
    expect(desktop.remoteHarnessSignInCancel).toHaveBeenCalledWith({
      projectId: "project-1",
      machineId: "m-1",
      harness: "codex",
      attempt: "att-1",
    });
    expect(signInOpen()).toBe(false);
  });

  it("signs out of Codex after asking in place", async () => {
    desktop.personalEnvironment.mockResolvedValue(view());
    desktop.remoteMachines.mockResolvedValue([machine({ codex: "signed-in" })]);
    desktop.remoteHarnessSignOut
      .mockRejectedValueOnce(new Error("ada-devbox is not connected."))
      .mockResolvedValueOnce({ signedOut: true });
    await render();

    await act(async () => labelled("Sign out of Codex on ada-devbox")?.click());
    expect(machineRow()?.textContent).toContain(
      "Sign out of Codex on ada-devbox? Codex chats there need you to sign in again.",
    );
    expect(document.activeElement?.textContent?.trim()).toBe("Cancel");
    expect(desktop.remoteHarnessSignOut).not.toHaveBeenCalled();
    await act(async () => button("Cancel")?.click());
    expect(document.activeElement).toBe(
      labelled("Sign out of Codex on ada-devbox"),
    );

    await act(async () => labelled("Sign out of Codex on ada-devbox")?.click());
    await act(async () => button("Sign out")?.click());
    expect(desktop.remoteHarnessSignOut).toHaveBeenCalledWith({
      projectId: "project-1",
      machineId: "m-1",
      harness: "codex",
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
  it("signs in to Claude Code: the link, a field for the code the page gives, and a check until it is done", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    desktop.personalEnvironment.mockResolvedValue(view());
    desktop.remoteMachines.mockResolvedValue([machine({ codex: "signed-in" })]);
    desktop.remoteHarnessSignIn.mockResolvedValue(linkFor("att-1"));
    const sent = deferred<{ state: "waiting" }>();
    desktop.remoteHarnessSignInCode.mockReturnValueOnce(sent.promise);
    desktop.remoteHarnessSignInStatus
      .mockResolvedValueOnce({ state: "waiting" })
      .mockResolvedValueOnce({ state: "signed-in" });
    desktop.openSignInLink.mockResolvedValue(undefined);
    await render();

    await act(async () =>
      labelled("Sign in to Claude Code on ada-devbox")?.click(),
    );
    expect(desktop.remoteHarnessSignIn).toHaveBeenCalledWith({
      projectId: "project-1",
      machineId: "m-1",
      harness: "claude-code",
    });
    const dialog = signInDialog();
    expect(
      document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "")
        ?.textContent,
    ).toBe("Sign in to Claude Code on ada-devbox");
    const text = dialog?.textContent ?? "";
    expect(text).toContain(
      "Claude Code signs in on the machine itself, so your Claude sign-in stays there.",
    );
    expect(text).toContain("claude.com/cai/oauth/authorize");
    expect(text).toContain("2. Paste the code the page gives you");
    expect(text).toContain("Expires in 15 minutes");
    expect(text).toContain(
      "Sign in with your own Claude account. Anthropic's terms for your plan apply to how you use it here.",
    );
    // Codex's device code hint is Codex's alone.
    expect(text).not.toContain("device code");
    expect(text).not.toMatch(/[–—]/);
    // Claude Code prints no code to show: the person brings one back.
    expect(code()).toBeNull();
    expect(labelled("Copy the code")).toBeNull();
    const field = codeField();
    expect(field?.getAttribute("aria-label")).toBe(
      "Code from the Claude Code sign-in page",
    );
    const submit = () => inDialog("Submit");
    expect(submit()?.disabled).toBe(true);
    expect(submit()?.dataset.disabledReason).toBe("Paste the code first");
    expect(signInDialog()?.textContent).toContain(
      "Waiting for the code from the sign-in page",
    );

    await act(async () => inDialog("Open sign-in page")?.click());
    expect(desktop.openSignInLink).toHaveBeenCalledWith(CLAUDE_LINK);

    // Spaces alone are no code.
    await act(async () => {
      if (field) typeInto(field, "   ");
    });
    expect(submit()?.disabled).toBe(true);
    const pasted = "pasted-code-7f3a#state";
    await act(async () => {
      if (field) typeInto(field, `  ${pasted} `);
    });
    expect(submit()?.disabled).toBe(false);
    await act(async () => submit()?.click());
    expect(desktop.remoteHarnessSignInCode).toHaveBeenCalledTimes(1);
    expect(desktop.remoteHarnessSignInCode).toHaveBeenCalledWith({
      projectId: "project-1",
      machineId: "m-1",
      harness: "claude-code",
      attempt: "att-1",
      text: pasted,
    });
    // Sent once and gone from the page: the field is empty and takes no more.
    expect(codeField()?.value).toBe("");
    expect(codeField()?.disabled).toBe(true);
    expect(document.body.innerHTML).not.toContain(pasted);
    expect(signInDialog()?.textContent).toContain("Sending the code");
    await act(async () => sent.resolve({ state: "waiting" }));
    expect(signInDialog()?.textContent).toContain("Finishing the sign-in");
    expect(submit()?.dataset.disabledReason).toBe("The code was sent");

    await advance(HARNESS_SIGN_IN_POLL_MS);
    expect(desktop.remoteHarnessSignInStatus).toHaveBeenCalledWith({
      projectId: "project-1",
      machineId: "m-1",
      harness: "claude-code",
      attempt: "att-1",
    });
    await advance(HARNESS_SIGN_IN_POLL_MS);
    expect(signInDialog()?.textContent).toContain(
      "Claude Code is signed in on ada-devbox.",
    );
    expect(signInDialog()?.textContent).toContain(
      "Your Claude Code chats there run on your Claude plan now.",
    );
    expect(signInRow("claude-code")?.textContent).toContain(
      "Claude Code signed in",
    );
    // Her Codex sign-in there is as it was.
    expect(signInRow("codex")?.textContent).toContain("Codex signed in");
    await act(async () => inDialog("Done")?.click());
    expect(signInOpen()).toBe(false);
    expect(desktop.remoteHarnessSignInCancel).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain(pasted);
  });

  it("says why a pasted code was not taken, and lets the person paste again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    desktop.personalEnvironment.mockResolvedValue(view());
    desktop.remoteMachines.mockResolvedValue([machine()]);
    desktop.remoteHarnessSignIn
      .mockResolvedValueOnce(linkFor("att-1"))
      .mockResolvedValueOnce(linkFor("att-2"));
    desktop.remoteHarnessSignInStatus.mockResolvedValue({ state: "waiting" });
    desktop.remoteHarnessSignInCancel.mockResolvedValue(undefined);
    desktop.remoteHarnessSignInCode
      .mockRejectedValueOnce(
        new Error("This machine is not connected right now."),
      )
      .mockResolvedValueOnce({
        state: "failed",
        message: "Error: invalid code the code",
      });
    await render();
    await act(async () =>
      labelled("Sign in to Claude Code on ada-devbox")?.click(),
    );

    const paste = async (value: string) => {
      const field = codeField();
      await act(async () => {
        if (field) typeInto(field, value);
      });
      await act(async () => inDialog("Submit")?.click());
    };
    // The machine could not be reached: its words, and the field again.
    await paste("first-code-1a2b");
    expect(
      signInDialog()?.querySelector('[data-testid="harness-sign-in-status"]')
        ?.textContent,
    ).toBe("This machine is not connected right now.");
    expect(codeField()?.disabled).toBe(false);
    expect(codeField()?.value).toBe("");

    // Claude Code refused the code: the sign-in ended, in its words.
    await paste("second-code-3c4d");
    expect(signInDialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "Error: invalid code the code",
    );
    expect(codeField()).toBeNull();
    expect(document.body.innerHTML).not.toContain("first-code-1a2b");
    expect(document.body.innerHTML).not.toContain("second-code-3c4d");
    // It ended on the machine: nothing is left to cancel.
    expect(desktop.remoteHarnessSignInCancel).not.toHaveBeenCalled();

    // Trying again starts a new sign-in with an empty field; a login nobody
    // finished says it ran out of time, not that a code expired.
    await act(async () => inDialog("Try again")?.click());
    expect(codeField()?.value).toBe("");
    expect(codeField()?.disabled).toBe(false);
    desktop.remoteHarnessSignInStatus.mockResolvedValueOnce({
      state: "expired",
    });
    await advance(HARNESS_SIGN_IN_POLL_MS);
    expect(signInDialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "The sign-in ran out of time.",
    );

    // Closing a waiting one cancels it, by harness.
    await act(async () => inDialog("Close")?.click());
    desktop.remoteHarnessSignIn.mockResolvedValueOnce(linkFor("att-3"));
    await act(async () =>
      labelled("Sign in to Claude Code on ada-devbox")?.click(),
    );
    await act(async () => inDialog("Cancel")?.click());
    expect(desktop.remoteHarnessSignInCancel).toHaveBeenCalledWith({
      projectId: "project-1",
      machineId: "m-1",
      harness: "claude-code",
      attempt: "att-3",
    });
  });

  it("signs out of Claude Code alone, after asking in place", async () => {
    desktop.personalEnvironment.mockResolvedValue(view());
    desktop.remoteMachines.mockResolvedValue([
      machine({ codex: "signed-in", claude: "signed-in" }),
    ]);
    desktop.remoteHarnessSignOut.mockResolvedValueOnce({ signedOut: true });
    await render();

    await act(async () =>
      labelled("Sign out of Claude Code on ada-devbox")?.click(),
    );
    expect(signInRow("claude-code")?.textContent).toContain(
      "Sign out of Claude Code on ada-devbox? Claude Code chats there need you to sign in again.",
    );
    // The other harness's row is not asking anything.
    expect(signInRow("codex")?.textContent).toBe("Codex signed inSign out");
    await act(async () => button("Sign out")?.click());
    expect(desktop.remoteHarnessSignOut).toHaveBeenCalledTimes(1);
    expect(desktop.remoteHarnessSignOut).toHaveBeenCalledWith({
      projectId: "project-1",
      machineId: "m-1",
      harness: "claude-code",
    });
    expect(signInRow("claude-code")?.textContent).toContain(
      "Claude Code not signed in",
    );
    expect(signInRow("codex")?.textContent).toContain("Codex signed in");
    expect(document.activeElement).toBe(
      labelled("Sign in to Claude Code on ada-devbox"),
    );
  });
});
