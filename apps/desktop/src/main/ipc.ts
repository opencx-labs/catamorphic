import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { definitionHash, type ProjectAgentEntry } from "@catamorphic/core";
import {
  buildInstallationUrl,
  GithubAuthError,
  pollDeviceToken,
  requestDeviceCode,
} from "@catamorphic/github";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { BindingAuth } from "./agent-bindings-store.js";
import {
  type AgentsStore,
  type CreateAgentInput,
  type PublicAgentConfig,
  toPublicAgent,
  type UpdateAgentInput,
} from "./agents-store.js";
import {
  type CreateConnectionInput,
  toPublicConnection,
  type UpdateConnectionInput,
} from "./connections-store.js";
import type { ConnectorsService } from "./connectors.js";
import { type GitDiffMode, gitFileDiff, gitOverview } from "./git-view.js";
import type { WindowProfileRegistry } from "./index.js";
import { type Keybindings, normalizeKeybindings } from "./keybindings.js";
import type { McpAppsService } from "./mcp-apps.js";
import {
  bestFreeModelId,
  fetchOpenRouterModels,
  openRouterPkceLogin,
} from "./openrouter.js";
import type { ProfileConfigManager } from "./profile-config.js";
import type { EmbeddedServer } from "./server/boot.js";
import { DESKTOP_TENANT_ID, DESKTOP_USER_ID } from "./server/boot.js";
import { GITHUB_APP } from "./server/github.js";
import { listAgentModels } from "./server/harness-models.js";
import type { DataPaths } from "./server/paths.js";
import {
  normalizeTheme,
  type ResolvedTheme,
  resolveTheme,
  THEME_PRESETS,
  windowBackgroundColor,
} from "./theme.js";

export interface ServerState {
  current: EmbeddedServer | null;
  /** Notify every open window (all profiles). */
  broadcast: (channel: string, payload: unknown) => void;
}

export interface AgentsSnapshot {
  agents: PublicAgentConfig[];
  defaultAgentId: string | null;
}

/** A project agent as the renderer sees it (definition + consent state). */
export interface ProjectAgentInfo {
  /** Registry id: `project:<projectId>:<slug>`. */
  id: string;
  projectId: string;
  slug: string;
  name: string;
  kind: string;
  description: string | null;
  model: string | null;
  effort: "low" | "medium" | "high" | null;
  credentialsSource: "profile" | "secret" | "local";
  secretName: string | null;
  /** Declared connector needs — informational in v1. */
  connections: string[];
  /** First lines of the persona file, for the consent dialog. */
  promptPreview: string | null;
  /**
   * Consent state for THIS profile: `not-required` (secret-credentialed),
   * `none` (never approved), `stale` (definition changed since approval),
   * or `ok`.
   */
  consent: "not-required" | "none" | "stale" | "ok";
  /** Set when the definition file is unusable; the agent can't run. */
  invalid: string | null;
}

export interface ProjectAgentsData {
  agents: ProjectAgentInfo[];
}

export function registerIpcHandlers(
  profileConfig: ProfileConfigManager,
  state: ServerState,
  windows: WindowProfileRegistry,
  paths: DataPaths,
  connectors?: ConnectorsService,
  mcpApps?: McpAppsService,
): void {
  const storesFor = (event: Electron.IpcMainInvokeEvent) =>
    profileConfig.forProfile(windows.profileFor(event.sender));

  // --- window ↔ profile ---

  ipcMain.handle("catamorphic:window-profile", (event) =>
    windows.profileFor(event.sender),
  );

  // In-place switch (empty workspace): rebind the window, then the renderer
  // refetches all profile-scoped state under its full-surface fade.
  ipcMain.handle(
    "catamorphic:window-set-profile",
    (event, profileId: string) => {
      windows.assign(event.sender, profileId);
      return windows.profileFor(event.sender);
    },
  );

  // Occupied workspace: the profile opens in its own window instead.
  ipcMain.handle(
    "catamorphic:open-profile-window",
    (_event, profileId: string) => {
      windows.openWindow(profileId);
    },
  );

  // --- per-profile config (theme, keybindings) ---

  ipcMain.handle("catamorphic:keybindings-get", (event) =>
    storesFor(event).keybindings.load(),
  );

  ipcMain.handle("catamorphic:theme-get", (event) =>
    storesFor(event).theme.resolved(),
  );

  ipcMain.handle("catamorphic:theme-presets", () =>
    THEME_PRESETS.map(({ id, label, colors }) => ({ id, label, colors })),
  );

  // Saving triggers the file watcher, which syncs the native window
  // background and broadcasts the resolved theme to the profile's windows.
  ipcMain.handle(
    "catamorphic:theme-set",
    (event, input: unknown): ResolvedTheme => {
      const store = storesFor(event).theme;
      const next = normalizeTheme(input);
      store.save(next);
      const resolved = resolveTheme(next);
      // Apply to the calling window synchronously so the UI can't flash
      // between the click and the watcher's debounce.
      const window = BrowserWindow.fromWebContents(event.sender);
      window?.setBackgroundColor(windowBackgroundColor(resolved));
      return resolved;
    },
  );

  ipcMain.handle(
    "catamorphic:theme-file",
    (event) => storesFor(event).theme.file,
  );

  // Saving triggers the same file watcher that external edits do, which
  // rebuilds the menu and broadcasts the change to the profile's windows.
  ipcMain.handle(
    "catamorphic:keybindings-set",
    (event, input: unknown): Keybindings => {
      const store = storesFor(event).keybindings;
      const next = normalizeKeybindings(input);
      store.save(next);
      return next;
    },
  );

  ipcMain.handle(
    "catamorphic:keybindings-file",
    (event) => storesFor(event).keybindings.file,
  );

  // --- per-profile app preferences (notifications) ---

  ipcMain.handle("catamorphic:prefs-get", (event) =>
    storesFor(event).prefs.load(),
  );

  // Saving triggers the file watcher, which broadcasts to the profile's
  // windows (same live-reload contract as keybindings).
  ipcMain.handle("catamorphic:prefs-set", (event, patch: unknown) =>
    storesFor(event).prefs.save(
      typeof patch === "object" && patch !== null ? patch : {},
    ),
  );

  // Desktop-notification clicks land here: surface the window so the
  // renderer can then focus the right chat.
  ipcMain.handle("catamorphic:window-focus", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  // --- per-profile agents ---

  const agentsSnapshot = (store: AgentsStore): AgentsSnapshot => ({
    agents: store.list().map(toPublicAgent),
    defaultAgentId: store.defaultAgentId() ?? null,
  });

  const agentsChanged = (
    event: Electron.IpcMainInvokeEvent,
    store: AgentsStore,
  ) => {
    const profileId = windows.profileFor(event.sender);
    for (const window of windows.windowsFor(profileId)) {
      window.webContents.send(
        "catamorphic:agents-changed",
        agentsSnapshot(store),
      );
    }
    // Chat affordances across all windows key off "any agent configured".
    state.broadcast("catamorphic:server-changed", {
      url: state.current?.url ?? null,
      hasCodingAgent: state.current?.hasCodingAgent ?? false,
    });
  };

  ipcMain.handle("catamorphic:agents-list", (event) =>
    agentsSnapshot(storesFor(event).agents),
  );

  ipcMain.handle(
    "catamorphic:agents-create",
    (event, input: CreateAgentInput) => {
      const store = storesFor(event).agents;
      const agent = store.create(input);
      agentsChanged(event, store);
      return toPublicAgent(agent);
    },
  );

  ipcMain.handle(
    "catamorphic:agents-update",
    (event, id: string, patch: UpdateAgentInput) => {
      const store = storesFor(event).agents;
      const agent = store.update(id, patch);
      agentsChanged(event, store);
      return agent ? toPublicAgent(agent) : null;
    },
  );

  ipcMain.handle("catamorphic:agents-remove", (event, id: string) => {
    const store = storesFor(event).agents;
    const removed = store.remove(id);
    if (removed) agentsChanged(event, store);
    return removed;
  });

  ipcMain.handle("catamorphic:agents-set-default", (event, id: string) => {
    const store = storesFor(event).agents;
    store.setDefault(id);
    agentsChanged(event, store);
  });

  // --- project agents (committed agents/<slug>.json definitions, ADR 0050) ---

  const kindHarness = (kind: string): "ai-sdk" | "claude-code" | "codex" =>
    kind === "claude-code"
      ? "claude-code"
      : kind === "codex"
        ? "codex"
        : "ai-sdk";

  const projectAgentInfo = (
    projectId: string,
    entry: ProjectAgentEntry,
  ): ProjectAgentInfo => {
    const owning = profileConfig.forProject(projectId);
    const definition = entry.definition;
    const source = definition?.credentials?.source ?? "profile";
    let consent: ProjectAgentInfo["consent"] = "not-required";
    if (definition && definition.kind !== "e2e-fake" && source !== "secret") {
      const binding = owning.agentBindings.get(projectId, entry.slug);
      const hash = definitionHash(definition, entry.promptFile);
      consent = !binding
        ? "none"
        : binding.consentHash === hash
          ? "ok"
          : "stale";
    }
    const promptPreview = entry.promptFile
      ? entry.promptFile.split("\n").slice(0, 6).join("\n").slice(0, 320)
      : null;
    return {
      id: `project:${projectId}:${entry.slug}`,
      projectId,
      slug: entry.slug,
      name: definition?.name ?? entry.slug,
      kind: definition?.kind ?? "unknown",
      description: definition?.description ?? null,
      model: definition?.model ?? null,
      effort: definition?.effort ?? null,
      credentialsSource: source,
      secretName: definition?.credentials?.secret ?? null,
      connections: definition?.connections ?? [],
      promptPreview,
      consent,
      invalid: entry.invalid?.error ?? null,
    };
  };

  ipcMain.handle(
    "catamorphic:project-agents-list",
    async (_event, projectId: string): Promise<ProjectAgentsData> => {
      const server = state.current;
      if (!server) return { agents: [] };
      try {
        const entries = await server.catamorphic.core.agentDefinitions.list(
          { tenantId: DESKTOP_TENANT_ID, externalUserId: DESKTOP_USER_ID },
          projectId,
        );
        return {
          agents: entries.map((entry) => projectAgentInfo(projectId, entry)),
        };
      } catch {
        // Unknown/deleted project: no agents rather than a broken palette.
        return { agents: [] };
      }
    },
  );

  // Approve = record consent for the definition's CURRENT hash, binding it
  // to the profile's matching existing auth: the roster's same-harness
  // agent's API key when it has one, else the machine's own CLI login for
  // the CLI kinds. The built-in kind needs a real key, so with none on the
  // roster the approval is refused with a pointer at Settings.
  ipcMain.handle(
    "catamorphic:project-agent-approve",
    async (
      _event,
      projectId: string,
      slug: string,
    ): Promise<{ ok: boolean; error?: string }> => {
      const server = state.current;
      if (!server) return { ok: false, error: "Server not running" };
      const entries = await server.catamorphic.core.agentDefinitions.list(
        { tenantId: DESKTOP_TENANT_ID, externalUserId: DESKTOP_USER_ID },
        projectId,
      );
      const entry = entries.find((candidate) => candidate.slug === slug);
      if (!entry?.definition) {
        return { ok: false, error: entry?.invalid?.error ?? "Agent not found" };
      }
      const definition = entry.definition;
      const source = definition.credentials?.source ?? "profile";
      if (source === "secret") {
        // Nothing personal to consent to; the secret is the authorization.
        return { ok: true };
      }
      const owning = profileConfig.forProject(projectId);
      const harness = kindHarness(definition.kind);
      const match = owning.agents
        .list()
        .find((agent) => agent.harness === harness);
      let auth: BindingAuth;
      if (definition.kind === "e2e-fake") {
        auth = { mode: "local" };
      } else if (match?.auth === "api-key" && match.apiKey) {
        auth = { mode: "api-key", apiKey: match.apiKey };
      } else if (harness === "ai-sdk") {
        // The built-in harness only speaks API keys; without one on the
        // roster there is nothing safe to bind.
        return {
          ok: false,
          error:
            "This agent uses the built-in harness, which needs an API key. Add one in Settings → Agents, then approve again.",
        };
      } else {
        auth = { mode: "local" };
      }
      owning.agentBindings.bind(projectId, slug, {
        consentHash: definitionHash(definition, entry.promptFile),
        auth,
      });
      return { ok: true };
    },
  );

  // --- profile-level MCP connections + connectors ---
  // Connections are the profile's configured MCP servers; connectors are
  // the install layer (MCP registry entries and Claude Code / Cowork
  // plugins). Secret values (headers, env) never cross the contextBridge.

  const connectionsChanged = (event: Electron.IpcMainInvokeEvent) => {
    const profileId = windows.profileFor(event.sender);
    const snapshot = storesFor(event)
      .connections.list()
      .map(toPublicConnection);
    for (const window of windows.windowsFor(profileId)) {
      window.webContents.send("catamorphic:connections-changed", snapshot);
    }
  };

  ipcMain.handle("catamorphic:connections-list", (event) =>
    storesFor(event).connections.list().map(toPublicConnection),
  );

  ipcMain.handle(
    "catamorphic:connections-create",
    (event, input: CreateConnectionInput) => {
      const connection = storesFor(event).connections.create(input);
      connectionsChanged(event);
      return toPublicConnection(connection);
    },
  );

  ipcMain.handle(
    "catamorphic:connections-update",
    (event, id: string, patch: UpdateConnectionInput) => {
      const connection = storesFor(event).connections.update(id, patch);
      connectionsChanged(event);
      return connection ? toPublicConnection(connection) : null;
    },
  );

  ipcMain.handle("catamorphic:connections-remove", (event, id: string) => {
    const removed = storesFor(event).connections.remove(id);
    if (removed) connectionsChanged(event);
    return removed;
  });

  ipcMain.handle("catamorphic:connections-probe", (event, id: string) =>
    connectors
      ? connectors.probeConnection(windows.profileFor(event.sender), id)
      : { ok: false, error: "Connectors are unavailable" },
  );

  ipcMain.handle("catamorphic:connectors-search", (event, query: string) =>
    connectors
      ? connectors.search(windows.profileFor(event.sender), String(query ?? ""))
      : { registry: [], plugins: [] },
  );

  ipcMain.handle("catamorphic:connectors-list", (event) =>
    connectors
      ? connectors.listInstalled(windows.profileFor(event.sender))
      : [],
  );

  ipcMain.handle(
    "catamorphic:connectors-install-registry",
    async (event, registryName: string, secrets: Record<string, string>) => {
      if (!connectors) throw new Error("Connectors are unavailable");
      const connection = await connectors.installRegistryServer(
        windows.profileFor(event.sender),
        registryName,
        secrets ?? {},
      );
      connectionsChanged(event);
      return connection;
    },
  );

  ipcMain.handle(
    "catamorphic:connectors-install-plugin",
    async (event, marketplace: string, pluginName: string) => {
      if (!connectors) throw new Error("Connectors are unavailable");
      const installed = await connectors.installPlugin(
        windows.profileFor(event.sender),
        marketplace,
        pluginName,
      );
      connectionsChanged(event);
      return installed;
    },
  );

  ipcMain.handle(
    "catamorphic:connectors-remove",
    async (event, name: string) => {
      if (!connectors) return false;
      const removed = await connectors.removeConnector(
        windows.profileFor(event.sender),
        name,
      );
      if (removed) connectionsChanged(event);
      return removed;
    },
  );

  // --- MCP Apps (embedded views for connection tools) ---

  ipcMain.handle("catamorphic:mcp-apps-ui-tools", async (event) => {
    if (!mcpApps) return {};
    try {
      return await mcpApps.uiTools(windows.profileFor(event.sender));
    } catch {
      return {};
    }
  });

  ipcMain.handle(
    "catamorphic:mcp-apps-view",
    async (event, toolKey: string) => {
      if (!mcpApps) throw new Error("MCP apps are unavailable");
      const profileId = windows.profileFor(event.sender);
      const view = await mcpApps.view(profileId, String(toolKey));
      // The renderer's iframe navigates to the served document (its own
      // CSP); the embedded server must therefore be up.
      const base = state.current?.url;
      if (!base) throw new Error("The embedded server is not ready");
      const url = new URL("/desktop/mcp-app-view", base);
      url.searchParams.set("profileId", profileId);
      url.searchParams.set("toolKey", view.toolKey);
      return { ...view, url: url.toString() };
    },
  );

  ipcMain.handle(
    "catamorphic:mcp-apps-call",
    async (
      event,
      viewToolKey: string,
      toolName: string,
      args: Record<string, unknown>,
    ) => {
      if (!mcpApps) throw new Error("MCP apps are unavailable");
      return mcpApps.callTool(
        windows.profileFor(event.sender),
        String(viewToolKey),
        String(toolName),
        args ?? {},
      );
    },
  );

  // OpenRouter's public catalog: feeds the searchable model selector and
  // reports the current best free model (nothing hardcoded app-side).
  ipcMain.handle("catamorphic:openrouter-models", async () => {
    const models = await fetchOpenRouterModels();
    return { models, bestFreeModelId: bestFreeModelId(models) ?? null };
  });

  // Local CLI setup detection for the agent wizard: does this machine
  // already have a Claude Code / Codex login the `local` auth mode can
  // inherit? (E2E reports both present so wizard flows stay scripted.)
  ipcMain.handle("catamorphic:agent-setup-status", () => {
    if (process.env.CATAMORPHIC_E2E_FAKE_AGENT === "1") {
      return { claudeCode: true, codex: true };
    }
    const home = app.getPath("home");
    return {
      claudeCode: [
        path.join(home, ".claude", ".credentials.json"),
        path.join(home, ".claude.json"),
      ].some((file) => fs.existsSync(file)),
      codex: fs.existsSync(path.join(home, ".codex", "auth.json")),
    };
  });

  // Supported models for one agent, resolved live per harness (Claude
  // Code's own catalog, `codex debug models`, provider /v1/models).
  ipcMain.handle("catamorphic:agent-models", async (event, id: string) => {
    const agent = storesFor(event).agents.get(id);
    if (!agent) return { models: [] };
    try {
      return {
        models: await listAgentModels(agent, {
          agentHome,
          codexBinary: resolveCodexBinary,
        }),
      };
    } catch (cause) {
      console.warn("[desktop] model listing failed:", cause);
      return { models: [] };
    }
  });

  // --- account login for host harnesses ---
  // Each account-auth agent owns a private home dir (CLAUDE_CONFIG_DIR /
  // CODEX_HOME), so two agents on one harness can hold different accounts.

  const agentHome = (agentId: string): string => {
    const dir = path.join(paths.agentHomesDir, agentId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  ipcMain.handle("catamorphic:agent-login-status", (event, id: string) => {
    const agent = storesFor(event).agents.get(id);
    if (!agent) return false;
    if (agent.auth === "api-key" || agent.harness === "ai-sdk") {
      return agent.apiKey !== null;
    }
    // `local` reads the machine's own CLI home; `account` the agent's.
    const home =
      agent.auth === "local"
        ? agent.harness === "codex"
          ? path.join(app.getPath("home"), ".codex")
          : path.join(app.getPath("home"), ".claude")
        : path.join(paths.agentHomesDir, id);
    const credentialFiles =
      agent.harness === "codex"
        ? [path.join(home, "auth.json")]
        : [path.join(home, ".credentials.json")];
    return credentialFiles.some((file) => fs.existsSync(file));
  });

  ipcMain.handle("catamorphic:agent-login", async (event, id: string) => {
    const store = storesFor(event).agents;
    const agent = store.get(id);
    if (agent === undefined || agent.auth === "api-key") {
      return { started: false, error: "This agent authenticates with a key" };
    }

    // E2E: logins would open browsers/terminals — stamp a fake credential
    // so onboarding flows run end to end without leaving the machine.
    if (process.env.CATAMORPHIC_E2E_FAKE_AGENT === "1") {
      if (agent.harness === "ai-sdk") {
        // A fresh key per login, like the real PKCE flow: the credential
        // change rebuilds the cached provider (agent-registry cache key),
        // so reconnect-then-retry e2e covers the production re-anchor path.
        store.update(id, { apiKey: `sk-or-e2e-fake-${Date.now()}` });
        agentsChanged(event, store);
      }
      // Deferred so the renderer's agentLogin() call resolves (and the
      // wizard registers the pending agent) before completion lands —
      // real logins always take longer than the invoke round-trip.
      setTimeout(() => {
        state.broadcast("catamorphic:agent-login-finished", {
          agentId: id,
          ok: true,
        });
      }, 50);
      return { started: true };
    }

    // Built-in agent on OpenRouter: browser PKCE — the scoped key lands in
    // the agent config, so the user never pastes one.
    if (agent.harness === "ai-sdk") {
      if (agent.provider !== "openrouter") {
        return { started: false, error: "This provider uses an API key" };
      }
      void openRouterPkceLogin((url) => void shell.openExternal(url))
        .then((key) => {
          store.update(id, { apiKey: key });
          agentsChanged(event, store);
          state.broadcast("catamorphic:agent-login-finished", {
            agentId: id,
            ok: true,
          });
        })
        .catch((cause) => {
          console.warn("[desktop] OpenRouter sign-in failed:", cause);
          state.broadcast("catamorphic:agent-login-finished", {
            agentId: id,
            ok: false,
          });
        });
      return { started: true };
    }
    const home = agentHome(id);

    if (agent.harness === "codex") {
      // The Codex CLI runs the whole OAuth dance itself: local callback
      // server + browser hand-off; the process exits when login completes.
      const binary = resolveCodexBinary();
      if (!binary) {
        return { started: false, error: "Codex CLI binary not found" };
      }
      const child = spawn(binary, ["login"], {
        // `local` signs into ~/.codex — shared with the user's own CLI.
        env:
          agent.auth === "account"
            ? { ...process.env, CODEX_HOME: home }
            : { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let opened = false;
      const watchForUrl = (chunk: Buffer) => {
        const match = /https:\/\/\S+/.exec(chunk.toString());
        if (match && !opened) {
          opened = true;
          void shell.openExternal(match[0]);
        }
      };
      child.stdout.on("data", watchForUrl);
      child.stderr.on("data", watchForUrl);
      child.on("exit", (code) => {
        state.broadcast("catamorphic:agent-login-finished", {
          agentId: id,
          ok: code === 0,
        });
      });
      return { started: true };
    }

    // Claude Code's login is an interactive TUI, so it needs a terminal.
    // We launch it by `open`ing a .command script rather than scripting
    // Terminal.app: AppleScript automation would demand a macOS Automation
    // permission (attributed to whatever launched us), and asking for that
    // to run a sign-in is a terrible first impression.
    const command =
      agent.auth === "account"
        ? `CLAUDE_CONFIG_DIR='${home}' claude /login`
        : "claude /login";
    if (process.platform === "darwin") {
      try {
        const script = path.join(agentHome(id), "sign-in.command");
        fs.writeFileSync(
          script,
          `#!/bin/sh\nclear\necho "Signing in to Claude Code for '${agent.name.replace(/'/g, "")}'."\necho\n${command}\n`,
          { mode: 0o755 },
        );
        spawn("open", [script], { stdio: "ignore" });
        return { started: true, command };
      } catch (cause) {
        console.warn("[desktop] Failed to open the sign-in terminal:", cause);
        return { started: false, command };
      }
    }
    return { started: false, command };
  });

  ipcMain.handle("catamorphic:server-state", () => ({
    url: state.current?.url ?? null,
    hasCodingAgent: state.current?.hasCodingAgent ?? false,
  }));

  // Dev-only: lets UI automation (CDP) drive window geometry, which
  // Electron's CDP endpoint does not support (no Browser.getWindowForTarget).
  if (!app.isPackaged) {
    ipcMain.handle(
      "catamorphic:dev-window",
      (
        event,
        action: "maximize" | "unmaximize" | "minimize" | "restore" | "setSize",
        width?: number,
        height?: number,
      ) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) return null;
        if (action === "setSize") {
          if (width && height) {
            if (window.isMaximized()) window.unmaximize();
            window.setBounds({ x: 0, y: 30, width, height });
          }
        } else {
          window[action]();
        }
        const bounds = window.getBounds();
        return { ...bounds, maximized: window.isMaximized() };
      },
    );
  }

  // Where new projects go by default: ~/Catamorphic/<name>. Always a real,
  // user-visible folder — project data never hides in app data. E2E runs
  // keep projects inside the throwaway userData dir instead of the home.
  ipcMain.handle("catamorphic:default-projects-dir", () =>
    process.env.CATAMORPHIC_E2E_DATA_DIR
      ? path.join(process.env.CATAMORPHIC_E2E_DATA_DIR, "Catamorphic")
      : path.join(app.getPath("home"), "Catamorphic"),
  );

  const identity = {
    tenantId: DESKTOP_TENANT_ID,
    externalUserId: DESKTOP_USER_ID,
  };

  // Project create/import runs through IPC (not HTTP): explicit filesystem
  // locations are a desktop capability, and the projectId → folder mapping is
  // desktop-owned state the shared API never sees.
  ipcMain.handle(
    "catamorphic:project-create",
    async (
      _event,
      input: {
        name: string;
        rootPath: string;
        templateId?: string;
        importExisting?: boolean;
      },
    ) => {
      const server = state.current;
      if (!server) throw new Error("Server not running");
      if (!path.isAbsolute(input.rootPath)) {
        throw new Error("rootPath must be an absolute path");
      }
      const project = await server.catamorphic.core.projects.create(identity, {
        name: input.name,
        templateId: input.templateId,
        rootPath: input.rootPath,
        importExisting: input.importExisting,
      });
      await server.projectRoots.set(project.id, input.rootPath);
      return { id: project.id, name: project.name };
    },
  );

  ipcMain.handle(
    "catamorphic:project-delete",
    async (_event, input: { projectId: string; trashFolder?: boolean }) => {
      const server = state.current;
      if (!server) throw new Error("Server not running");
      const rootPath = await server.projectRoots.get(input.projectId);
      // Trash first: a failed trash should leave the project intact rather
      // than half-deleted, and after the row is gone we lose the path.
      if (input.trashFolder && rootPath) {
        await shell.trashItem(rootPath);
      }
      await server.catamorphic.core.projects.delete(identity, input.projectId);
      await server.projectRoots.delete(input.projectId);
    },
  );

  ipcMain.handle(
    "catamorphic:project-root",
    (_event, projectId: string): Promise<string | null> => {
      const server = state.current;
      if (!server) return Promise.resolve(null);
      return server.projectRoots.get(projectId);
    },
  );

  ipcMain.handle(
    "catamorphic:pick-folder",
    async (
      event,
      opts?: { title?: string; defaultPath?: string },
    ): Promise<string | null> => {
      // E2E: CDP cannot drive the native folder dialog — a seeded path
      // stands in for the user's pick so import flows run end to end.
      if (
        process.env.CATAMORPHIC_E2E_DATA_DIR &&
        process.env.CATAMORPHIC_E2E_PICK_FOLDER
      ) {
        return process.env.CATAMORPHIC_E2E_PICK_FOLDER;
      }
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return null;
      const result = await dialog.showOpenDialog(window, {
        title: opts?.title ?? "Choose a folder",
        defaultPath: opts?.defaultPath,
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  );

  ipcMain.handle("catamorphic:reveal-folder", (_event, folderPath: string) => {
    if (path.isAbsolute(folderPath)) shell.openPath(folderPath);
  });

  // --- git + pull requests (the dev-grade surfaces: Changes, PRs, diffs) ---

  ipcMain.handle(
    "catamorphic:git-overview",
    async (_event, projectId: string) => {
      const rootPath = await state.current?.projectRoots.get(projectId);
      if (!rootPath) return { available: false, worktrees: [] };
      return gitOverview(rootPath);
    },
  );

  ipcMain.handle(
    "catamorphic:git-file-diff",
    async (
      _event,
      projectId: string,
      worktreePath: string,
      filePath: string,
      mode: GitDiffMode,
    ) => {
      if (mode !== "uncommitted" && mode !== "vs-main") {
        throw new Error(`Unknown diff mode: ${String(mode)}`);
      }
      const rootPath = await state.current?.projectRoots.get(projectId);
      if (!rootPath) throw new Error("Unknown project");
      // Only diff inside the project's own worktrees. Worktrees may live
      // OUTSIDE the project root, so this is an allowlist from `git
      // worktree list`, not a path-prefix check.
      const overview = await gitOverview(rootPath);
      if (!overview.worktrees.some((tree) => tree.path === worktreePath)) {
        throw new Error("Not a worktree of this project");
      }
      return gitFileDiff(worktreePath, filePath, mode);
    },
  );

  ipcMain.handle("catamorphic:pr-list", (_event, projectId: string) => {
    const server = state.current;
    if (!server) return [];
    return server.catamorphic.core.remoteSync.listPullRequests(
      identity,
      projectId,
    );
  });

  ipcMain.handle(
    "catamorphic:pr-files",
    (_event, projectId: string, number: number) => {
      const server = state.current;
      if (!server) throw new Error("Server not running");
      return server.catamorphic.core.remoteSync.pullRequestFiles(
        identity,
        projectId,
        Number(number),
      );
    },
  );

  // --- GitHub device flow ---
  // The flow lives in the main process: it opens the system browser and
  // polls GitHub, while the renderer only ever sees the short user code and
  // the final connected/failed state. Tokens go straight into the embedded
  // server's GithubService (encrypted via safeStorage before touching disk).
  let deviceFlowGeneration = 0;

  ipcMain.handle("catamorphic:github-connect-start", async () => {
    const grant = await requestDeviceCode(GITHUB_APP);
    const generation = ++deviceFlowGeneration;
    void shell.openExternal(grant.verificationUri);

    const poll = async (): Promise<void> => {
      const started = Date.now();
      let intervalMs = grant.interval * 1000;
      while (Date.now() - started < grant.expiresIn * 1000) {
        // A newer connect attempt or an app shutdown obsoletes this loop.
        if (generation !== deviceFlowGeneration) return;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        const server = state.current;
        if (!server) return;
        try {
          const result = await pollDeviceToken(GITHUB_APP, grant.deviceCode);
          if (result.tokens) {
            const status = await server.catamorphic.core.github?.connect(
              identity,
              result.tokens,
            );
            state.broadcast("catamorphic:github-connected", status ?? null);
            return;
          }
          if (result.retryAfter > 0) intervalMs = result.retryAfter * 1000;
        } catch (cause) {
          state.broadcast("catamorphic:github-connected", {
            error:
              cause instanceof GithubAuthError
                ? cause.message
                : "GitHub authorization failed",
          });
          return;
        }
      }
      state.broadcast("catamorphic:github-connected", {
        error: "The GitHub device code expired. Try connecting again",
      });
    };
    void poll();

    return {
      userCode: grant.userCode,
      verificationUri: grant.verificationUri,
    };
  });

  // Repo access is granted by *installing* the GitHub App, not by the OAuth
  // authorization itself — send users to the installation page where GitHub
  // shows the repository picker.
  ipcMain.handle("catamorphic:github-manage-repos", () => {
    void shell.openExternal(buildInstallationUrl(GITHUB_APP));
  });

  ipcMain.handle("catamorphic:github-disconnect", async () => {
    deviceFlowGeneration += 1;
    const server = state.current;
    if (!server) return;
    await server.catamorphic.core.github?.disconnect(identity);
  });

  // Import runs through IPC (not HTTP) for the same reason project-create
  // does: the destination folder is a desktop-owned filesystem path.
  ipcMain.handle(
    "catamorphic:github-import",
    async (
      _event,
      input: { fullName: string; name?: string; rootPath: string },
    ) => {
      const server = state.current;
      if (!server) throw new Error("Server not running");
      if (!server.catamorphic.core.github) {
        throw new Error("GitHub integration not configured");
      }
      if (!path.isAbsolute(input.rootPath)) {
        throw new Error("rootPath must be an absolute path");
      }
      const project = await server.catamorphic.core.github.importRepo(
        identity,
        {
          fullName: input.fullName,
          name: input.name,
          rootPath: input.rootPath,
        },
      );
      await server.projectRoots.set(project.id, input.rootPath);
      return { id: project.id, name: project.name };
    },
  );
}

/**
 * The Codex SDK vendors the native CLI per platform under
 * `@openai/codex/vendor/<rust-target>/bin/codex` — resolve it so login runs
 * the exact binary the agent will use, with no PATH assumptions.
 */
function resolveCodexBinary(): string | null {
  const targets: Record<string, string> = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-musl",
    "linux-arm64": "aarch64-unknown-linux-musl",
    "win32-x64": "x86_64-pc-windows-msvc",
  };
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) return null;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("@openai/codex/package.json");
    const binary = path.join(
      path.dirname(pkg),
      "vendor",
      target,
      "bin",
      process.platform === "win32" ? "codex.exe" : "codex",
    );
    return fs.existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}
