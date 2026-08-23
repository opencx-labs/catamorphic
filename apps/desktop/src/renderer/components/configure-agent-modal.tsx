import {
  Cable,
  Check,
  FileText,
  KeyRound,
  Settings2,
  Star,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import {
  type AgentAuthMode,
  type AgentConnectionsSetting,
  type AgentCoordinationStrategy,
  type AgentEffort,
  type AgentHarness,
  type AgentInfo,
  type AgentMode,
  type AgentSkillsSetting,
  type AgentsData,
  type ConnectionInfo,
  desktopApi,
  type McpToolPolicy,
  type ProjectAgentInfo,
  type ProjectAgentsData,
  type UpdateAgentInput,
} from "../lib/desktop-api.js";
import { AgentSkillsField } from "./agent-skills-field.js";
import { AgentToolPolicyField } from "./agent-tool-policy-field.js";
import { ConnectionsAssignmentField } from "./connections-field.js";
import { Modal } from "./modal.js";
import { AnimatedHeight, ModalTab } from "./modal-tabs.js";
import { OpenRouterModelField } from "./openrouter-model-field.js";
import { PendingButton } from "./pending-button.js";

const HARNESS_LABELS: Record<AgentHarness, string> = {
  "ai-sdk": "Built-in",
  "claude-code": "Claude Code",
  codex: "Codex",
};

const MODEL_PLACEHOLDERS: Record<AgentHarness, string> = {
  "ai-sdk": "claude-sonnet-4-5",
  "claude-code": "claude-sonnet-4-5",
  codex: "gpt-5.3-codex",
};

const EFFORT_OPTIONS: Array<{ value: AgentEffort; label: string }> = [
  { value: "low", label: "Low — fast, direct" },
  { value: "medium", label: "Medium — balanced" },
  { value: "high", label: "High — thorough" },
  { value: "xhigh", label: "Extra high — extended reasoning" },
  { value: "max", label: "Max — deepest reasoning" },
];

const MODE_OPTIONS: Array<{
  value: AgentMode;
  label: string;
  detail: string;
}> = [
  {
    value: "read-only",
    label: "Read-only",
    detail: "Explore and answer; no edits, no commands.",
  },
  {
    value: "edit",
    label: "Edit",
    detail: "Work in the project folder without prompts (the default).",
  },
  {
    value: "full-access",
    label: "Full access",
    detail: "The harness's own safety checks are off. For trusted work only.",
  },
];

const COORDINATION_OPTIONS: Array<{
  value: AgentCoordinationStrategy;
  label: string;
  detail: string;
}> = [
  {
    value: "shared-first",
    label: "Share the project folder",
    detail: "Share unless concurrent work is likely to interfere.",
  },
  {
    value: "isolate-on-contention",
    label: "Prefer a worktree when others are active",
    detail: "Use isolation when another active session makes it safer.",
  },
  {
    value: "isolation-required",
    label: "Always isolate concurrent editing",
    detail: "Do not share a checkout with another active editor.",
  },
];

type Tab = "general" | "prompt" | "capabilities" | "auth";

/**
 * THE surface for configuring one agent (ADR 0056), opened from the
 * palette ("Configure agent…") and from Settings. Profile agents get the
 * full tabbed form; project agents (committed definitions) are files, so
 * they get a read-only view with consent and default-agent actions.
 */
export function ConfigureAgentModal({
  open,
  agentId,
  projectId,
  onClose,
}: {
  open: boolean;
  /** Roster agent id or `project:<projectId>:<slug>`. */
  agentId: string | null;
  projectId?: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<AgentsData | null>(null);
  const [projectAgents, setProjectAgents] = useState<ProjectAgentsData | null>(
    null,
  );

  useEffect(() => {
    void desktopApi.agentsList().then(setData);
    return desktopApi.onAgentsChanged(setData);
  }, []);
  useEffect(() => {
    if (!open || !projectId) return;
    void desktopApi.projectAgentsList(projectId).then(setProjectAgents);
  }, [open, projectId]);

  const profileAgent = useMemo(
    () => data?.agents.find((agent) => agent.id === agentId) ?? null,
    [data, agentId],
  );
  const projectAgent = useMemo(
    () => projectAgents?.agents.find((agent) => agent.id === agentId) ?? null,
    [projectAgents, agentId],
  );

  return (
    <Modal open={open} onClose={onClose} width={560}>
      {profileAgent ? (
        <ProfileAgentBody
          // Re-mount per open/agent so stale drafts never leak between edits.
          key={`${profileAgent.id} ${open}`}
          agent={profileAgent}
          data={data}
          projectId={projectId}
          onClose={onClose}
        />
      ) : projectAgent ? (
        <ProjectAgentBody
          key={`${projectAgent.id} ${open}`}
          agent={projectAgent}
          data={data}
          projectDefaultSlug={projectAgents?.projectDefaultSlug ?? null}
          onRefresh={() => {
            if (projectId) {
              void desktopApi
                .projectAgentsList(projectId)
                .then(setProjectAgents);
            }
          }}
          onClose={onClose}
        />
      ) : (
        <div className="p-5">
          <p className="text-sm text-fg-muted">
            {agentId ? "This agent no longer exists." : "No agent selected."}
          </p>
        </div>
      )}
    </Modal>
  );
}

/**
 * The default-agent layers (ADR 0056) as immediate actions — like the
 * Settings star, these apply on click, outside the Save patch: they are
 * pointers at the agent, not part of it.
 */
function DefaultRows({
  agentId,
  data,
  projectId,
  projectSlug,
  projectDefaultSlug,
  onProjectDefaultChanged,
}: {
  agentId: string;
  data: AgentsData | null;
  projectId?: string;
  /** Set for project agents: enables the committed-default toggle. */
  projectSlug?: string;
  projectDefaultSlug?: string | null;
  onProjectDefaultChanged?: () => void;
}) {
  const isGlobalDefault = data?.defaultAgentId === agentId;
  const isProjectOverride =
    projectId !== undefined && data?.projectDefaults[projectId] === agentId;
  const isProjectDefault =
    projectSlug !== undefined && projectDefaultSlug === projectSlug;

  const row = (
    label: string,
    detail: string,
    active: boolean,
    onToggle: (() => void) | null,
    testId: string,
  ) => (
    <button
      type="button"
      onClick={onToggle ?? undefined}
      disabled={!onToggle}
      data-testid={testId}
      className={`flex w-full items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-left transition-colors duration-150 ${
        onToggle ? "cursor-pointer hover:border-fg-faint" : "cursor-default"
      }`}
    >
      <Star
        className={`size-3.5 shrink-0 ${
          active ? "fill-current text-fg" : "text-fg-faint"
        }`}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] text-fg">{label}</span>
        <span className="block truncate text-[11px] text-fg-faint">
          {detail}
        </span>
      </span>
      {active && <Check className="size-3.5 shrink-0 text-fg-muted" />}
    </button>
  );

  return (
    <div className="flex flex-col gap-1 text-xs text-fg-muted">
      Default agent
      <div className="flex flex-col gap-1">
        {row(
          "My default agent",
          "Answers new chats everywhere, unless a project says otherwise.",
          isGlobalDefault,
          isGlobalDefault
            ? null
            : () => void desktopApi.agentsSetDefault(agentId),
          "default-global",
        )}
        {projectId &&
          row(
            "My default in this project",
            isProjectOverride
              ? "Your override for this project — click to clear it."
              : "Override the project's default, just for you.",
            isProjectOverride,
            () =>
              void desktopApi.agentsSetProjectDefault(
                projectId,
                isProjectOverride ? null : agentId,
              ),
            "default-project-override",
          )}
        {projectId &&
          projectSlug &&
          row(
            "Project default (everyone)",
            isProjectDefault
              ? "Committed in .catamorphic/project.json — click to clear it."
              : "Commit as the project's default for every collaborator.",
            isProjectDefault,
            () =>
              void desktopApi
                .projectAgentsSetDefault(
                  projectId,
                  isProjectDefault ? null : projectSlug,
                )
                .then(onProjectDefaultChanged),
            "default-project",
          )}
      </div>
    </div>
  );
}

function ProfileAgentBody({
  agent,
  data,
  projectId,
  onClose,
}: {
  agent: AgentInfo;
  data: AgentsData | null;
  projectId?: string;
  onClose: () => void;
}) {
  const harness = agent.harness;
  const [tab, setTab] = useState<Tab>("general");
  const [name, setName] = useState(agent.name);
  const [provider, setProvider] = useState(agent.provider ?? "anthropic");
  const [model, setModel] = useState(agent.model);
  const [effort, setEffort] = useState<AgentEffort>(agent.effort);
  const [mode, setMode] = useState<AgentMode>(agent.mode);
  const [coordination, setCoordination] = useState<AgentCoordinationStrategy>(
    agent.coordination,
  );
  const [instructions, setInstructions] = useState(agent.instructions);
  const [memory, setMemory] = useState(agent.memory);
  const [auth, setAuth] = useState<AgentAuthMode>(agent.auth);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [connections, setConnections] = useState<AgentConnectionsSetting>(
    agent.connections,
  );
  const [skills, setSkills] = useState<AgentSkillsSetting>(agent.skills);
  const [toolPolicies, setToolPolicies] = useState<
    Record<string, McpToolPolicy>
  >(agent.toolPolicies ?? {});
  const [profileConnections, setProfileConnections] = useState<
    ConnectionInfo[]
  >([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void desktopApi
      .connectionsList()
      .then(setProfileConnections)
      .catch(() => {});
    return desktopApi.onConnectionsChanged(setProfileConnections);
  }, []);

  // Anthropic/OpenAI are key-only; OpenRouter can also sign in with an
  // account, and the CLI harnesses add "this machine's login" on top.
  const effectiveAuth: AgentAuthMode =
    harness === "ai-sdk" && provider !== "openrouter"
      ? "api-key"
      : harness === "ai-sdk" && auth === "local"
        ? "account"
        : auth;
  const hasSavedKey = agent.hasApiKey && !clearKey;
  const keyPlaceholder = hasSavedKey
    ? `Saved (${agent.apiKeyMasked}) — leave empty to keep`
    : harness === "codex" || (harness === "ai-sdk" && provider === "openai")
      ? "sk-…"
      : harness === "ai-sdk" && provider === "openrouter"
        ? "sk-or-…"
        : "sk-ant-…";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const patch: UpdateAgentInput = {
        name: name.trim() || undefined,
        model: model.trim(),
        effort,
        mode,
        coordination,
        memory,
        instructions,
        auth: effectiveAuth,
        connections,
        skills,
        toolPolicies,
      };
      if (harness === "ai-sdk") patch.provider = provider;
      if (clearKey) patch.apiKey = null;
      else if (apiKey.trim()) patch.apiKey = apiKey.trim();
      await desktopApi.agentsUpdate(agent.id, patch);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} data-testid="configure-agent-modal">
      <div className="px-5 pt-5 pb-1">
        <h2 className="mb-3 truncate text-[16px] font-semibold">
          {agent.name}
          <span className="ml-2 text-xs font-normal text-fg-faint">
            {HARNESS_LABELS[harness]}
          </span>
        </h2>
        <div
          className="grid grid-cols-4 gap-1 rounded-lg bg-bg-inset p-1"
          role="tablist"
          aria-label="Agent settings"
        >
          <ModalTab
            active={tab === "general"}
            onSelect={() => setTab("general")}
            icon={<Settings2 className="size-3.5" />}
            label="General"
            testId="agent-tab-general"
          />
          <ModalTab
            active={tab === "prompt"}
            onSelect={() => setTab("prompt")}
            icon={<FileText className="size-3.5" />}
            label="Prompt"
            testId="agent-tab-prompt"
          />
          <ModalTab
            active={tab === "capabilities"}
            onSelect={() => setTab("capabilities")}
            icon={<Cable className="size-3.5" />}
            label="Capabilities"
            testId="agent-tab-capabilities"
          />
          <ModalTab
            active={tab === "auth"}
            onSelect={() => setTab("auth")}
            icon={<KeyRound className="size-3.5" />}
            label="Auth"
            testId="agent-tab-auth"
          />
        </div>
      </div>

      <AnimatedHeight>
        <div
          key={tab}
          className="animate-fade-in flex flex-col gap-3 px-5 py-4"
        >
          {tab === "general" && (
            <>
              <label className="flex flex-col gap-1 text-xs text-fg-muted">
                Name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={HARNESS_LABELS[harness]}
                  className="field h-8 px-2 text-[13px] text-fg placeholder:text-fg-faint"
                  spellCheck={false}
                />
              </label>

              {harness === "ai-sdk" && (
                <label className="flex flex-col gap-1 text-xs text-fg-muted">
                  Provider
                  <select
                    value={provider}
                    onChange={(event) => {
                      const next = event.target.value as typeof provider;
                      setProvider(next);
                      setAuth(next === "openrouter" ? "account" : "api-key");
                    }}
                    className="field h-8 px-2 text-[13px] text-fg"
                  >
                    <option value="anthropic">Anthropic</option>
                    <option value="openai">OpenAI</option>
                    <option value="openrouter">OpenRouter</option>
                  </select>
                </label>
              )}

              {harness === "ai-sdk" && provider === "openrouter" ? (
                <OpenRouterModelField value={model} onChange={setModel} />
              ) : (
                <label className="flex flex-col gap-1 text-xs text-fg-muted">
                  Model
                  <input
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder={MODEL_PLACEHOLDERS[harness]}
                    className="field h-8 px-2 font-mono text-[13px] text-fg placeholder:font-sans placeholder:text-fg-faint"
                    spellCheck={false}
                  />
                  <span className="text-fg-faint">
                    {harness === "ai-sdk"
                      ? "Any model id your API key can access."
                      : "Leave empty to use the harness default."}
                  </span>
                </label>
              )}

              <label className="flex flex-col gap-1 text-xs text-fg-muted">
                Effort
                <select
                  value={effort}
                  onChange={(event) =>
                    setEffort(event.target.value as AgentEffort)
                  }
                  className="field h-8 px-2 text-[13px] text-fg"
                  data-testid="agent-effort"
                >
                  {EFFORT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {harness === "codex" &&
                  (effort === "max" || effort === "xhigh") && (
                    <span className="text-fg-faint">
                      Codex tops out at extra high; max runs there.
                    </span>
                  )}
              </label>

              {harness !== "ai-sdk" && (
                <label className="flex flex-col gap-1 text-xs text-fg-muted">
                  Mode
                  <select
                    value={mode}
                    onChange={(event) =>
                      setMode(event.target.value as AgentMode)
                    }
                    className="field h-8 px-2 text-[13px] text-fg"
                    data-testid="agent-mode"
                  >
                    {MODE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <span className="text-fg-faint">
                    {
                      MODE_OPTIONS.find((option) => option.value === mode)
                        ?.detail
                    }
                  </span>
                </label>
              )}

              <DefaultRows
                agentId={agent.id}
                data={data}
                projectId={projectId}
              />
            </>
          )}

          {tab === "prompt" && (
            <>
              <label className="flex flex-col gap-1 text-xs text-fg-muted">
                Instructions
                <textarea
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                  placeholder={`You are ${name.trim() || "this agent"}. …`}
                  rows={10}
                  className="field min-h-40 resize-y px-2 py-1.5 text-[13px] leading-relaxed text-fg placeholder:text-fg-faint"
                  spellCheck={false}
                  data-testid="agent-instructions"
                />
                <span className="text-fg-faint">
                  The agent's own main prompt. It leads every session — the
                  app's playbooks follow it — like a project agent's
                  agents/&lt;slug&gt;.md persona.
                </span>
              </label>

              {harness === "claude-code" && (
                <label className="flex cursor-pointer items-start gap-2 text-xs text-fg-muted">
                  <input
                    type="checkbox"
                    checked={memory}
                    onChange={(event) => setMemory(event.target.checked)}
                    className="mt-0.5"
                    data-testid="agent-memory"
                  />
                  <span>
                    <span className="block text-[12px] text-fg">Memory</span>
                    <span className="block text-[11px] text-fg-faint">
                      Let Claude Code keep a persistent auto-memory. Off (the
                      default): every session starts clean and writes nothing —
                      remembered context changes an agent over time without you
                      seeing it.
                    </span>
                  </span>
                </label>
              )}
            </>
          )}

          {tab === "capabilities" && (
            <>
              <label className="flex flex-col gap-1 text-xs text-fg-muted">
                Concurrent work
                <select
                  value={coordination}
                  onChange={(event) =>
                    setCoordination(
                      event.target.value as AgentCoordinationStrategy,
                    )
                  }
                  className="field h-8 px-2 text-[13px] text-fg"
                  data-testid="agent-coordination"
                >
                  {COORDINATION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <span className="text-fg-faint">
                  {
                    COORDINATION_OPTIONS.find(
                      (option) => option.value === coordination,
                    )?.detail
                  }
                </span>
              </label>
              {profileConnections.length > 0 && (
                <ConnectionsAssignmentField
                  value={connections}
                  onChange={setConnections}
                  available={profileConnections}
                />
              )}
              <AgentSkillsField
                value={skills}
                onChange={setSkills}
                projectId={projectId}
              />
              <AgentToolPolicyField
                value={toolPolicies}
                onChange={setToolPolicies}
                connections={profileConnections}
                assignment={connections}
                harness={harness}
                projectId={projectId}
              />
            </>
          )}

          {tab === "auth" && (
            <>
              {(harness !== "ai-sdk" || provider === "openrouter") && (
                <label className="flex flex-col gap-1 text-xs text-fg-muted">
                  Authentication
                  <select
                    value={effectiveAuth}
                    onChange={(event) =>
                      setAuth(event.target.value as AgentAuthMode)
                    }
                    className="field h-8 px-2 text-[13px] text-fg"
                  >
                    {harness !== "ai-sdk" && (
                      <option value="local">This machine's login</option>
                    )}
                    <option value="account">
                      {harness === "ai-sdk"
                        ? "Account (sign in — no key needed)"
                        : "Separate account"}
                    </option>
                    <option value="api-key">API key</option>
                  </select>
                </label>
              )}

              {effectiveAuth === "api-key" ? (
                <label className="flex flex-col gap-1 text-xs text-fg-muted">
                  API key
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(event) => {
                      setApiKey(event.target.value);
                      if (event.target.value) setClearKey(false);
                    }}
                    placeholder={keyPlaceholder}
                    className="field h-8 px-2 font-mono text-[13px] text-fg placeholder:font-sans placeholder:text-fg-faint"
                    autoComplete="off"
                  />
                  <span className="flex items-center justify-between gap-2 text-fg-faint">
                    {clearKey
                      ? "Saved key will be removed."
                      : "Stored encrypted with your OS keychain."}
                    {agent.hasApiKey && (
                      <button
                        type="button"
                        onClick={() => setClearKey((value) => !value)}
                        className="shrink-0 cursor-pointer text-fg-muted hover:text-fg"
                      >
                        {clearKey ? "Keep saved key" : "Clear saved key"}
                      </button>
                    )}
                  </span>
                </label>
              ) : (
                <p className="text-xs text-fg-faint">
                  {effectiveAuth === "local"
                    ? "Uses this machine's existing CLI sign-in — nothing stored here."
                    : "Signs in as its own account; manage the sign-in from Settings → Agents."}
                </p>
              )}
            </>
          )}
        </div>
      </AnimatedHeight>

      <div className="flex items-center gap-2 px-5 pb-5">
        <PendingButton
          type="submit"
          pending={saving}
          pendingLabel="Saving…"
          disabled={
            effectiveAuth === "api-key" && !hasSavedKey && !apiKey.trim()
          }
          data-testid="agent-save"
          className="h-8 cursor-pointer rounded-md bg-accent px-4 text-[13px] font-medium text-accent-fg disabled:cursor-not-allowed disabled:opacity-50"
        >
          Save
        </PendingButton>
        <button
          type="button"
          onClick={onClose}
          className="h-8 cursor-pointer rounded-md px-3 text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
        >
          Cancel
        </button>
        {error ? (
          <p className="min-w-0 flex-1 truncate text-xs text-danger">{error}</p>
        ) : effectiveAuth === "api-key" && !hasSavedKey && !apiKey.trim() ? (
          // The disable spans tabs; say why from any of them.
          <p className="min-w-0 flex-1 truncate text-[11px] text-fg-faint">
            Needs an API key — Auth tab.
          </p>
        ) : null}
      </div>
    </form>
  );
}

/**
 * A committed project agent is code: the modal shows what the definition
 * says, its consent state, and the default-agent actions — editing means
 * editing `agents/<slug>.json` (and the `<slug>.md` persona) in the repo.
 */
function ProjectAgentBody({
  agent,
  data,
  projectDefaultSlug,
  onRefresh,
  onClose,
}: {
  agent: ProjectAgentInfo;
  data: AgentsData | null;
  projectDefaultSlug: string | null;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const approve = async () => {
    setApproving(true);
    setError(null);
    const result = await desktopApi.projectAgentApprove(
      agent.projectId,
      agent.slug,
    );
    setApproving(false);
    if (!result.ok) setError(result.error ?? "Approval failed.");
    else onRefresh();
  };

  const fact = (label: string, value: string | null) =>
    value ? (
      <div className="flex items-baseline gap-2 text-[12px]">
        <span className="w-24 shrink-0 text-fg-faint">{label}</span>
        <span className="min-w-0 flex-1 truncate text-fg">{value}</span>
      </div>
    ) : null;

  return (
    <div
      className="flex flex-col gap-3 p-5"
      data-testid="configure-agent-modal"
    >
      <h2 className="truncate text-[16px] font-semibold">
        {agent.name}
        <span className="ml-2 text-xs font-normal text-fg-faint">
          Project agent
        </span>
      </h2>

      {agent.invalid ? (
        <p className="text-xs text-danger">{agent.invalid}</p>
      ) : (
        <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-bg-inset/60 p-3">
          {fact("Harness", agent.kind)}
          {fact("Model", agent.model ?? "harness default")}
          {fact("Effort", agent.effort ?? "medium")}
          {fact("Mode", agent.mode ?? "edit")}
          {fact("Concurrent work", agent.coordination ?? "shared-first")}
          {fact(
            "Memory",
            agent.kind === "claude-code" ? (agent.memory ? "on" : "off") : null,
          )}
          {fact(
            "Credentials",
            agent.credentialsSource === "secret"
              ? `project secret ${agent.secretName ?? ""}`
              : agent.credentialsSource === "local"
                ? "this machine's login"
                : "your profile credentials",
          )}
          {fact(
            "Connections",
            agent.connections.length > 0 ? agent.connections.join(", ") : "all",
          )}
          {fact("Skills", agent.skills ? agent.skills.join(", ") : "all")}
          {agent.promptPreview && (
            <div className="mt-1 border-t border-border pt-2">
              <p className="mb-1 text-[11px] text-fg-faint">Persona</p>
              <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] text-fg-muted">
                {agent.promptPreview}
              </pre>
            </div>
          )}
        </div>
      )}

      {agent.consent === "none" || agent.consent === "stale" ? (
        <div className="flex items-center gap-2">
          <PendingButton
            type="button"
            pending={approving}
            pendingLabel="Approving…"
            onClick={() => void approve()}
            className="h-8 cursor-pointer rounded-md bg-accent px-4 text-[13px] font-medium text-accent-fg"
          >
            {agent.consent === "stale" ? "Approve changes" : "Approve"}
          </PendingButton>
          <p className="min-w-0 flex-1 text-[11px] text-fg-faint">
            {agent.consent === "stale"
              ? "The definition changed since you approved it."
              : "Needed before it runs on your credentials."}
          </p>
        </div>
      ) : null}
      {error && <p className="text-xs text-danger">{error}</p>}

      <DefaultRows
        agentId={agent.id}
        data={data}
        projectId={agent.projectId}
        projectSlug={agent.slug}
        projectDefaultSlug={projectDefaultSlug}
        onProjectDefaultChanged={onRefresh}
      />

      <p className="text-[11px] text-fg-faint">
        This agent is defined by <code>agents/{agent.slug}.json</code>
        {agent.promptPreview ? (
          <>
            {" "}
            and <code>agents/{agent.slug}.md</code>
          </>
        ) : null}{" "}
        in the project — edit those files (or ask a chat to) to change it.
      </p>

      <div>
        <button
          type="button"
          onClick={onClose}
          className="h-8 cursor-pointer rounded-md px-3 text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
        >
          Close
        </button>
      </div>
    </div>
  );
}
