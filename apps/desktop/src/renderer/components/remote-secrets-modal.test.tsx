// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RemoteProjectMember,
  RemoteProjectSecret,
} from "../lib/desktop-api.js";
import { RemoteSecretsModal } from "./remote-secrets-modal.js";

const desktop = vi.hoisted(() => ({
  remoteSecrets: vi.fn(),
  remoteSecretSet: vi.fn(),
  remoteSecretDelete: vi.fn(),
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

/** Types into a React-controlled field the way a paste would. */
function typeInto(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();

function secret(
  overrides: Partial<RemoteProjectSecret> = {},
): RemoteProjectSecret {
  return {
    name: "CLICKHOUSE_API_KEY",
    description: "Your ClickHouse key",
    required: false,
    source: "project",
    environments: ["dev"],
    shared: false,
    updatedAt: null,
    setBy: null,
    own: false,
    ownUpdatedAt: null,
    members: [],
    ...overrides,
  };
}

const MEMBERS: RemoteProjectMember[] = [
  {
    externalUserId: "u-ada",
    name: "Ada",
    email: "ada@example.test",
    roles: ["engineer"],
  },
  {
    externalUserId: "u-bob",
    name: "Bob",
    email: "bob@example.test",
    roles: ["engineer"],
  },
];

async function render(props: { canManage?: boolean; canList?: boolean } = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <RemoteSecretsModal
        open
        projectId="project-1"
        canManage={props.canManage ?? false}
        canListMembers={props.canList ?? false}
        onClose={() => {}}
      />,
    );
  });
}

const button = (label: string) =>
  document.body.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
const buttonText = (text: string) =>
  Array.from(document.body.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );

describe("RemoteSecretsModal", () => {
  it("shows what each secret is for and where it is set, never a value", async () => {
    desktop.remoteSecrets.mockResolvedValue({
      secrets: [
        secret({ shared: true, updatedAt: hourAgo }),
        secret({
          name: "SENTRY_DSN",
          description: undefined,
          environments: [],
        }),
      ],
      members: null,
    });
    await render();
    expect(desktop.remoteSecrets).toHaveBeenCalledWith({
      projectId: "project-1",
      members: false,
    });
    const text = document.body.textContent ?? "";
    expect(text).toContain("CLICKHOUSE_API_KEY");
    expect(text).toContain("Your ClickHouse key");
    expect(text).toContain("Set in Environment dev");
    expect(text).toContain("Not set: your chats use the shared value");
    expect(text).toContain("No Environment sets it in chats yet");
    // A member without secrets:write edits only their own value.
    expect(text).not.toContain("Shared value");
    expect(text).not.toContain("Members' values");
    expect(text).not.toMatch(/[–—]/);
  });

  it("sets and clears the member's own value", async () => {
    desktop.remoteSecrets.mockResolvedValue({
      secrets: [secret()],
      members: null,
    });
    desktop.remoteSecretSet.mockResolvedValue(undefined);
    await render();

    await act(async () =>
      button("Set Your value of CLICKHOUSE_API_KEY")?.click(),
    );
    const input = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="New value of CLICKHOUSE_API_KEY for Your value"]',
    );
    expect(input?.type).toBe("password");
    expect(buttonText("Save")?.disabled).toBe(true);
    desktop.remoteSecrets.mockResolvedValue({
      secrets: [secret({ own: true, ownUpdatedAt: hourAgo })],
      members: null,
    });
    await act(async () => {
      if (input) typeInto(input, "ch-key-123456");
    });
    await act(async () => buttonText("Save")?.click());
    expect(desktop.remoteSecretSet).toHaveBeenCalledWith({
      projectId: "project-1",
      name: "CLICKHOUSE_API_KEY",
      value: "ch-key-123456",
      member: "me",
    });
    // The field is gone and the value is never shown back.
    expect(document.body.querySelector("input")).toBeNull();
    expect(document.body.textContent).not.toContain("ch-key-123456");
    expect(document.body.textContent).toContain("Set 1h ago");

    desktop.remoteSecretDelete.mockResolvedValue(undefined);
    await act(async () =>
      button("Clear Your value of CLICKHOUSE_API_KEY")?.click(),
    );
    expect(desktop.remoteSecretDelete).toHaveBeenCalledWith({
      projectId: "project-1",
      name: "CLICKHOUSE_API_KEY",
      member: "me",
    });
  });

  it("lets a manager set the shared value and a member's own", async () => {
    desktop.remoteSecrets.mockResolvedValue({
      secrets: [
        secret({
          members: [{ member: "u-bob", updatedAt: hourAgo, setBy: "u-bob" }],
        }),
      ],
      members: MEMBERS,
    });
    desktop.remoteSecretSet.mockResolvedValue(undefined);
    desktop.remoteSecretDelete.mockResolvedValue(undefined);
    await render({ canManage: true, canList: true });
    expect(desktop.remoteSecrets).toHaveBeenCalledWith({
      projectId: "project-1",
      members: true,
    });
    expect(document.body.textContent).toContain("Members' values1 set");

    await act(async () =>
      button("Set Shared value of CLICKHOUSE_API_KEY")?.click(),
    );
    const shared = document.body.querySelector<HTMLInputElement>(
      'input[type="password"]',
    );
    await act(async () => {
      if (shared) typeInto(shared, "shared-key-1");
    });
    await act(async () => buttonText("Save")?.click());
    expect(desktop.remoteSecretSet).toHaveBeenLastCalledWith({
      projectId: "project-1",
      name: "CLICKHOUSE_API_KEY",
      value: "shared-key-1",
    });

    await act(async () => buttonText("Members' values1 set")?.click());
    const list = document.body.querySelector(
      '[data-testid="remote-secret-members"]',
    );
    expect(list?.textContent).toContain("Ada");
    expect(list?.textContent).toContain("Bob");
    await act(async () => button("Set Ada of CLICKHOUSE_API_KEY")?.click());
    const ada = document.body.querySelector<HTMLInputElement>(
      'input[type="password"]',
    );
    await act(async () => {
      if (ada) typeInto(ada, "ada-key-1234");
    });
    await act(async () => buttonText("Save")?.click());
    expect(desktop.remoteSecretSet).toHaveBeenLastCalledWith({
      projectId: "project-1",
      name: "CLICKHOUSE_API_KEY",
      value: "ada-key-1234",
      member: "u-ada",
    });

    await act(async () => button("Clear Bob of CLICKHOUSE_API_KEY")?.click());
    expect(desktop.remoteSecretDelete).toHaveBeenCalledWith({
      projectId: "project-1",
      name: "CLICKHOUSE_API_KEY",
      member: "u-bob",
    });
  });

  it("shows why a change was refused", async () => {
    desktop.remoteSecrets.mockResolvedValue({
      secrets: [secret()],
      members: null,
    });
    desktop.remoteSecretSet.mockRejectedValue(
      new Error("Saving CLICKHOUSE_API_KEY: Not authorized"),
    );
    await render();
    await act(async () =>
      button("Set Your value of CLICKHOUSE_API_KEY")?.click(),
    );
    const input = document.body.querySelector<HTMLInputElement>(
      'input[type="password"]',
    );
    await act(async () => {
      if (input) typeInto(input, "value-123456");
    });
    await act(async () => buttonText("Save")?.click());
    expect(
      document.body.querySelector('[data-testid="remote-secrets-status"]')
        ?.textContent,
    ).toContain("Not authorized");
  });

  it("says how to declare secrets when there are none", async () => {
    desktop.remoteSecrets.mockResolvedValue({ secrets: [], members: null });
    await render();
    expect(document.body.textContent).toContain(
      'Declare them under "secrets" in .work/project.json',
    );
  });
});
