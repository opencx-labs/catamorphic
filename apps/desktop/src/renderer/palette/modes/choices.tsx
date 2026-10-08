import {
  Bot,
  Cpu,
  Gauge,
  type LucideIcon,
  Settings2,
  Settings as SettingsIcon,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActionId } from "../../../shared/actions.js";
import { permissionModeLabel } from "../../../shared/agent-permissions.js";
import { BUILTIN_PALETTE_TRIGGERS } from "../../../shared/palette.js";
import {
  defaultModelLabel,
  modelId,
  useAgentDefaultModel,
} from "../../lib/agent-default-model.js";
import { effectiveEffort, supportedEfforts } from "../../lib/agent-effort.js";
import { permissionModeChoices } from "../../lib/agent-permissions.js";
import { switchContinuity } from "../../lib/agent-switch.js";
import { commandScore } from "../../lib/command-score.js";
import {
  type AgentEffort,
  type AgentInfo,
  desktopApi,
  type HarnessModelInfo,
  type OpenRouterCatalog,
  type ProjectAgentInfo,
  projectAgentAsInfo,
} from "../../lib/desktop-api.js";
import { usePaletteHost } from "../host.js";
import { pinCurrentFirst } from "../load.js";
import type { PaletteChoiceMode, PaletteItem, PaletteMode } from "../types.js";

const CHOICE_CHIPS: Record<
  PaletteChoiceMode,
  { chip: string; icon: LucideIcon; placeholder: string; description?: string }
> = {
  "default-agent": {
    chip: "Default agent",
    icon: Bot,
    placeholder: "Pick the profile's default agent…",
  },
  "switch-agent": {
    chip: "Chat agent",
    icon: Bot,
    placeholder: "Pick an agent for this chat…",
  },
  "configure-agent": {
    chip: "Configure",
    icon: Settings2,
    placeholder: "Pick an agent to configure…",
  },
  effort: {
    chip: "Effort",
    icon: Gauge,
    placeholder: "Pick reasoning effort…",
    description: "Change how deeply the agent reasons",
  },
  "permission-mode": {
    chip: "Permission mode",
    icon: ShieldCheck,
    placeholder: "Pick the agent's permission mode…",
    description: "Change what the agent may do without asking",
  },
  model: {
    chip: "Model",
    icon: Cpu,
    placeholder: "Type or pick a model…",
    description: "Change the model the agent runs on",
  },
};

export const isChoiceMode = (id: string): id is PaletteChoiceMode =>
  Object.hasOwn(CHOICE_CHIPS, id);

/** Action rows that enter a choice mode instead of running an app handler. */
export const PICKER_ACTIONS: Partial<Record<ActionId, PaletteChoiceMode>> = {
  "default-agent": "default-agent",
  "switch-agent": "switch-agent",
  "configure-agent": "configure-agent",
  "change-effort": "effort",
  "change-permission-mode": "permission-mode",
  "switch-model": "model",
};

const HARNESS_LABELS: Record<AgentInfo["harness"], string> = {
  "ai-sdk": "Built-in",
  "claude-code": "Claude Code",
  codex: "Codex",
};

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

/**
 * What an agent runs on, for the faded detail: the built-in agent is
 * named by its provider (the harness name says nothing useful next to a
 * user-chosen agent name), the CLIs by the harness.
 */
function agentSourceLabel(agent: AgentInfo): string {
  if (agent.harness === "ai-sdk" && agent.provider) {
    return PROVIDER_LABELS[agent.provider] ?? agent.provider;
  }
  return HARNESS_LABELS[agent.harness];
}

/** Kind labels for PROJECT agents (committed definitions, ADR 0050). */
const PROJECT_KIND_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  builtin: "Built-in",
  acp: "ACP",
  "e2e-fake": "Fake harness",
};

/** Faded detail for a project-agent row: kind + consent state (or error). */
function projectAgentDetail(agent: ProjectAgentInfo): string {
  if (agent.invalid) return agent.invalid;
  const kind = PROJECT_KIND_LABELS[agent.kind] ?? agent.kind;
  const state =
    agent.consent === "none"
      ? "needs approval"
      : agent.consent === "stale"
        ? "changed — approve again"
        : agent.credentialsSource === "secret"
          ? "project secret"
          : agent.credentialsSource === "connection"
            ? "server model connection"
            : "approved";
  return `${kind} · ${state}`;
}

/** How it authenticates, in the user's terms. */
function agentAuthLabel(agent: AgentInfo): string {
  if (agent.auth === "api-key") return "API key";
  if (agent.auth === "local") return "this machine";
  return agent.harness === "ai-sdk" && agent.provider === "openrouter"
    ? "signed in"
    : "separate account";
}

const EFFORT_LEVELS: Array<{
  id: AgentEffort;
  label: string;
  description: string;
}> = [
  { id: "low", label: "Low effort", description: "Fast, direct responses" },
  { id: "medium", label: "Medium effort", description: "Balanced reasoning" },
  { id: "high", label: "High effort", description: "Deep, thorough reasoning" },
  {
    id: "xhigh",
    label: "Extra-high effort",
    description: "Extended reasoning (Codex's deepest)",
  },
  {
    id: "max",
    label: "Max effort",
    description: "Deepest reasoning",
  },
];

/** Choice rows answer the active question and put the palette away. */
const asAnswer = (row: PaletteItem): PaletteItem =>
  row.commit ? row : { ...row, commit: "answer" };

/**
 * The choice modes: model, effort, permission mode and the three agent
 * pickers. Their rows load only while one of them is active.
 */
export function useChoiceModes({
  picker,
  projectAgents,
}: {
  picker: PaletteChoiceMode | null;
  projectAgents: readonly ProjectAgentInfo[];
}) {
  const {
    projectId,
    onOpenTab,
    agents,
    defaultAgentId,
    focusedChat,
    onPickDefaultAgent,
    onPickSessionAgent,
    onPickProjectAgent,
    onConfigureAgent,
    defaultAgentOverridden,
    onClearDefaultOverride,
    onPickEffort,
    onPickModel,
    onPickHarnessPermissions,
    actionAvailability,
  } = usePaletteHost();
  // OpenRouter catalog for the model picker, fetched when first needed
  // (main caches it for an hour).
  const [catalog, setCatalog] = useState<OpenRouterCatalog | null>(null);
  // Per-agent supported models (Claude Code / Codex / provider APIs),
  // resolved live by main — never a hardcoded list.
  const [harnessModels, setHarnessModels] = useState<{
    agentId: string;
    models: HarnessModelInfo[];
    error?: string;
  } | null>(null);

  // The model picker's target: the focused chat's agent, else the default.
  const targetAgent = useMemo(
    () =>
      [...agents, ...projectAgents.map(projectAgentAsInfo)].find(
        (candidate) =>
          candidate.id === ((focusedChat?.agentId ?? defaultAgentId) || ""),
      ),
    [agents, projectAgents, focusedChat?.agentId, defaultAgentId],
  );

  useEffect(() => {
    if ((picker !== "model" && picker !== "effort") || !targetAgent) return;
    let cancelled = false;
    if (
      targetAgent.harness === "ai-sdk" &&
      targetAgent.provider === "openrouter"
    ) {
      if (catalog === null) {
        void desktopApi.openrouterModels().then((data) => {
          if (!cancelled) setCatalog(data);
        });
      }
    } else if (harnessModels?.agentId !== targetAgent.id) {
      void desktopApi
        .agentModels(targetAgent.id)
        .then((data) => {
          if (!cancelled) {
            setHarnessModels({
              agentId: targetAgent.id,
              models: data.models,
              error: data.error,
            });
          }
        })
        .catch(() => {
          if (!cancelled)
            setHarnessModels({
              agentId: targetAgent.id,
              models: [],
              error: "Could not load models. Try again.",
            });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [picker, catalog, harnessModels, targetAgent]);

  const effortModel =
    harnessModels?.agentId === targetAgent?.id
      ? harnessModels?.models.find(
          (model) =>
            model.id === (focusedChat?.model || targetAgent?.model) ||
            model.resolvedId === (focusedChat?.model || targetAgent?.model),
        )
      : undefined;
  // What the default row means right now, asked of the harness, so picking
  // it is an informed choice. (OpenRouter shows its catalog pick instead;
  // the other built-in providers always pin a model.)
  const harnessDefault = useAgentDefaultModel({
    projectId,
    agent: targetAgent,
    sessionId: focusedChat?.sessionId,
    enabled: picker === "model" && targetAgent?.harness !== "ai-sdk",
  });

  const modelRows = useCallback(
    (query: string): PaletteItem[] => {
      const trimmed = query.trim();
      if (!targetAgent) {
        return [
          {
            id: "pick:none",
            icon: SettingsIcon,
            label: "No agents configured",
            detail: "Open Settings to add one",
            keywords: [],
            kind: "navigate",
            run: () =>
              onOpenTab({
                kind: "settings",
                name: "settings",
                label: "Settings",
              }),
          },
        ];
      }
      const agent = targetAgent;
      // A focused session selects only its override. Empty means "inherit the
      // agent", even when that agent itself pins a concrete model.
      const current = focusedChat ? (focusedChat.model ?? "") : agent.model;
      const rows: PaletteItem[] = [];
      if (agent.harness === "ai-sdk" && agent.provider === "openrouter") {
        const modelRow = (model: OpenRouterCatalog["models"][number]) =>
          ({
            id: `pick:model:${model.id}`,
            icon: Cpu,
            label: model.name,
            detail: model.id,
            keywords: [],
            kind: "action",
            ...(model.id === current ? { current: true } : {}),
            run: () => onPickModel(agent.id, model.id),
          }) satisfies PaletteItem;
        rows.push({
          id: "pick:model:",
          icon: Cpu,
          label: focusedChat ? "Agent default" : "Automatic model",
          detail:
            focusedChat && agent.model
              ? agent.model
              : (catalog?.bestFreeModelId ?? "resolved from the catalog"),
          keywords: ["best", "free", "auto", "default"],
          kind: "action",
          ...(current === "" ? { current: true } : {}),
          run: () => onPickModel(agent.id, ""),
        });
        const models = (catalog?.models ?? [])
          .slice()
          .sort(
            (a, b) => Number(b.free) - Number(a.free) || b.created - a.created,
          );
        // The unfiltered list pins the CURRENT model right under the
        // automatic row — picking a model must show what runs today.
        // While searching, normal ranking applies (the check still marks
        // the current row wherever it lands).
        if (!trimmed && current) {
          const pinned = models.find((model) => model.id === current);
          rows.push(
            pinned
              ? modelRow(pinned)
              : {
                  id: `pick:model:${current}`,
                  icon: Cpu,
                  label: current,
                  keywords: [],
                  kind: "action",
                  current: true,
                  run: () => onPickModel(agent.id, current),
                },
          );
        }
        // Zero state: the newest free models only — the browsable shortlist.
        // Typing searches the whole catalog.
        const matched = trimmed
          ? models
              .map((model) => ({
                model,
                score: commandScore(`${model.name} ${model.id}`, trimmed, []),
              }))
              .filter((entry) => entry.score > 0)
              .sort((a, b) => b.score - a.score)
              .map((entry) => entry.model)
          : models
              .filter((model) => model.free && model.id !== current)
              .sort((a, b) => b.created - a.created)
              .slice(0, 20);
        for (const model of matched.slice(0, 50)) {
          rows.push(modelRow(model));
        }
        return trimmed ? rows : pinCurrentFirst(rows);
      }
      // CLIs run their own default; Anthropic/OpenAI need an explicit id.
      if (focusedChat || agent.harness !== "ai-sdk") {
        rows.push({
          id: "pick:model:",
          icon: Cpu,
          label: focusedChat ? "Agent default" : defaultModelLabel(agent, null),
          detail:
            focusedChat && agent.model
              ? modelId(
                  agent.model,
                  harnessModels?.agentId === agent.id
                    ? harnessModels.models
                    : undefined,
                )
              : harnessDefault.data?.model
                ? defaultModelLabel(agent, harnessDefault.data.model)
                : undefined,
          keywords: ["default", "auto"],
          kind: "action",
          ...(current === "" ? { current: true } : {}),
          run: () => onPickModel(agent.id, ""),
        });
      }
      // Supported values straight from the harness (Claude Code's own
      // catalog, Codex app-server `model/list`, or the provider's /v1/models).
      const supported =
        harnessModels?.agentId === agent.id ? harnessModels.models : [];
      if (
        harnessModels?.agentId !== agent.id ||
        harnessModels.error ||
        supported.length === 0
      ) {
        rows.push({
          id: "pick:model:catalog-status",
          commit: "stay",
          icon: Cpu,
          label:
            harnessModels?.agentId !== agent.id
              ? "Loading models…"
              : harnessModels.error
                ? "Could not load models"
                : "No models returned",
          detail: harnessModels?.error ?? "Refresh the model list",
          keywords: [],
          kind: "action",
          run: () => {
            setHarnessModels(null);
          },
        });
      }
      const supportedRow = (model: HarnessModelInfo) =>
        ({
          id: `pick:model:${model.id}`,
          icon: Cpu,
          label: model.name,
          // Aliases ("sonnet") show the versioned id they resolve to.
          detail: modelId(model.id, supported),
          keywords: [],
          kind: "action",
          ...(model.id === current ? { current: true } : {}),
          run: () => onPickModel(agent.id, model.id),
        }) satisfies PaletteItem;
      // A pinned model the harness didn't list still needs a visible row.
      const customCurrentRow: PaletteItem | null =
        current && !supported.some((model) => model.id === current)
          ? {
              id: `pick:model:${current}`,
              icon: Cpu,
              label: current,
              keywords: [],
              kind: "action",
              current: true,
              run: () => onPickModel(agent.id, current),
            }
          : null;
      const matchedSupported = trimmed
        ? supported
            .map((model) => ({
              model,
              score: commandScore(`${model.name} ${model.id}`, trimmed, []),
            }))
            .filter((entry) => entry.score > 0)
            .sort((a, b) => b.score - a.score)
            .map((entry) => entry.model)
        : // Unfiltered: pin the current model to the top of the list
          // (normal ranking takes over the moment the user types).
          supported
            .slice()
            .sort(
              (a, b) => Number(b.id === current) - Number(a.id === current),
            );
      if (customCurrentRow && !trimmed) rows.push(customCurrentRow);
      for (const model of matchedSupported.slice(0, 50)) {
        rows.push(supportedRow(model));
      }
      if (customCurrentRow && trimmed) rows.push(customCurrentRow);
      if (
        trimmed &&
        trimmed !== current &&
        !supported.some((model) => model.id === trimmed)
      ) {
        rows.push({
          id: `pick:model-custom`,
          icon: Cpu,
          label: `Use "${trimmed}"`,
          detail: "Set this model id",
          keywords: [],
          kind: "action",
          run: () => onPickModel(agent.id, trimmed),
        });
      }
      return trimmed ? rows : pinCurrentFirst(rows);
    },
    [
      targetAgent,
      focusedChat,
      catalog,
      harnessModels,
      harnessDefault.data?.model,
      onPickModel,
      onOpenTab,
    ],
  );
  const choiceItems = useMemo<PaletteItem[]>(() => {
    if (!picker || picker === "model") return [];
    // A started chat switched to another harness carries on from a summary
    // of the conversation (lib/agent-switch): the row says so.
    const fromSummary = (harness: AgentInfo["harness"]) =>
      picker === "switch-agent" &&
      switchContinuity({
        started: Boolean(focusedChat?.sessionId),
        current: targetAgent?.harness,
        next: harness,
      }) === "summary";
    const build = (): PaletteItem[] => {
      const rows: PaletteItem[] =
        picker === "permission-mode"
          ? permissionModeChoices(targetAgent).map((choice) => ({
              id: `pick:permission:${choice.id}`,
              icon: ShieldCheck,
              label: choice.label,
              detail: choice.detail,
              keywords: choice.keywords,
              kind: "action" as const,
              ...(choice.current ? { current: true } : {}),
              run: () => {
                if (targetAgent)
                  onPickHarnessPermissions(targetAgent.id, choice.patch);
              },
            }))
          : picker === "effort"
            ? [
                ...(focusedChat
                  ? [
                      {
                        id: "pick:effort:default",
                        icon: Gauge,
                        label: "Agent default",
                        detail:
                          effectiveEffort(
                            targetAgent,
                            targetAgent?.effort,
                            effortModel,
                          ) ?? "Unavailable",
                        keywords: ["default", "inherit", "effort"],
                        kind: "action" as const,
                        ...(focusedChat.effort === null
                          ? { current: true }
                          : {}),
                        run: () => onPickEffort(null),
                      },
                    ]
                  : []),
                ...EFFORT_LEVELS.filter((level) =>
                  supportedEfforts(targetAgent, effortModel).includes(level.id),
                ).map((level) => {
                  const current = effectiveEffort(
                    targetAgent,
                    focusedChat ? focusedChat.effort : targetAgent?.effort,
                    effortModel,
                  );
                  return {
                    id: `pick:effort:${level.id}`,
                    icon: Gauge,
                    label: level.label,
                    detail: level.description,
                    keywords: [level.id, "effort", "reasoning"],
                    kind: "action" as const,
                    // Supported levels keep their low-to-high order; the check
                    // alone marks the active one (no reordering).
                    ...(level.id === current ? { current: true } : {}),
                    run: () => onPickEffort(level.id),
                  };
                }),
              ]
            : [
                ...agents.map((agent) => {
                  const isCurrent =
                    picker === "configure-agent"
                      ? false
                      : picker === "default-agent"
                        ? agent.id === defaultAgentId
                        : agent.id ===
                          ((focusedChat?.agentId ?? defaultAgentId) || "");
                  return {
                    id: `pick:agent:${agent.id}`,
                    icon: picker === "configure-agent" ? Settings2 : Bot,
                    label: agent.name,
                    detail: fromSummary(agent.harness)
                      ? `${agentSourceLabel(agent)} · continues from a summary`
                      : [
                          agentSourceLabel(agent),
                          agentAuthLabel(agent),
                          permissionModeLabel({
                            harness: agent.harness,
                            permissions: agent.harnessPermissions,
                          }),
                        ]
                          .filter(Boolean)
                          .join(" · "),
                    keywords: [
                      agent.name,
                      agent.harness,
                      agent.provider ?? "",
                      agent.model,
                    ],
                    kind: "action" as const,
                    ...(isCurrent ? { current: true } : {}),
                    run: () =>
                      picker === "default-agent"
                        ? onPickDefaultAgent(agent.id)
                        : picker === "configure-agent"
                          ? onConfigureAgent(agent.id)
                          : onPickSessionAgent(agent.id),
                  };
                }),
                // The active project's committed agents (ADR 0050), under
                // their own scope label. Invalid definitions stay visible —
                // disabled, with the error where the description goes — so
                // a typo'd file is diagnosable from the picker itself. The
                // configure picker keeps them clickable: its modal shows
                // the full error and where to fix it.
                ...projectAgents.map((agent) => {
                  const isCurrent =
                    picker === "configure-agent"
                      ? false
                      : picker === "default-agent"
                        ? agent.id === defaultAgentId
                        : agent.id ===
                          ((focusedChat?.agentId ?? defaultAgentId) || "");
                  return {
                    id: `pick:agent:${agent.id}`,
                    icon: picker === "configure-agent" ? Settings2 : Bot,
                    label: agent.name,
                    // Its approval state stays first: it decides the pick.
                    detail:
                      !agent.invalid &&
                      fromSummary(projectAgentAsInfo(agent).harness)
                        ? `${projectAgentDetail(agent)} · continues from a summary`
                        : projectAgentDetail(agent),
                    keywords: [agent.name, agent.slug, "project", agent.kind],
                    kind: "action" as const,
                    group: "Project agents",
                    ...(isCurrent ? { current: true } : {}),
                    ...(agent.invalid && picker !== "configure-agent"
                      ? { disabled: true }
                      : {}),
                    run: () => {
                      if (picker === "configure-agent") {
                        onConfigureAgent(agent.id);
                        return;
                      }
                      if (agent.invalid) return;
                      onPickProjectAgent(
                        agent,
                        picker === "default-agent" ? "default" : "session",
                      );
                    },
                  };
                }),
                // Layered defaults (ADR 0056): while this user's per-project
                // override is set, offer the way back to the layers below.
                ...(picker === "default-agent" && defaultAgentOverridden
                  ? [
                      {
                        id: "pick:agent-default-clear",
                        icon: Bot,
                        label: "Use the project's default",
                        detail:
                          "Clear your override for this project (falls back to the project, then your global default)",
                        keywords: ["clear", "project", "default", "reset"],
                        kind: "action" as const,
                        run: () => onClearDefaultOverride?.(),
                      },
                    ]
                  : []),
              ];
      if (rows.length === 0) {
        return [
          {
            id: "pick:none",
            icon: SettingsIcon,
            label: "No agents configured",
            detail: "Open Settings to add one",
            keywords: [],
            kind: "navigate",
            run: () =>
              onOpenTab({
                kind: "settings",
                name: "settings",
                label: "Settings",
              }),
          },
        ];
      }
      return rows;
    };
    return build().map(asAnswer);
  }, [
    picker,
    targetAgent,
    focusedChat,
    effortModel,
    agents,
    projectAgents,
    defaultAgentId,
    defaultAgentOverridden,
    onPickHarnessPermissions,
    onPickEffort,
    onPickDefaultAgent,
    onPickSessionAgent,
    onPickProjectAgent,
    onConfigureAgent,
    onClearDefaultOverride,
    onOpenTab,
  ]);

  const modes = useMemo<PaletteMode[]>(() => {
    const choice = (
      id: PaletteChoiceMode,
      rows: PaletteMode["rows"],
      typed?: readonly string[],
    ): PaletteMode => ({
      id,
      ...CHOICE_CHIPS[id],
      label: CHOICE_CHIPS[id].chip,
      names: typed,
      rows,
      // The chat a choice changes glows while its question is open.
      highlight:
        id === "switch-agent"
          ? "chat"
          : id === "model" || id === "effort" || id === "permission-mode"
            ? "chat-if-focused"
            : undefined,
    });
    // Typed names follow the commands' availability (a project agent has no
    // editable model; some harnesses have no permission modes).
    const hasAgent = agents.length > 0 || Boolean(defaultAgentId);
    const typed = (
      action: ActionId,
      id: "model" | "effort" | "permission-mode",
    ) =>
      hasAgent && actionAvailability?.[action] !== false
        ? BUILTIN_PALETTE_TRIGGERS[id]
        : undefined;
    return [
      choice(
        "model",
        { kind: "compute", rows: (query) => modelRows(query).map(asAnswer) },
        typed("switch-model", "model"),
      ),
      choice(
        "effort",
        { kind: "list", items: picker === "effort" ? choiceItems : [] },
        typed("change-effort", "effort"),
      ),
      choice(
        "permission-mode",
        {
          kind: "list",
          items: picker === "permission-mode" ? choiceItems : [],
        },
        typed("change-permission-mode", "permission-mode"),
      ),
      ...(["default-agent", "switch-agent", "configure-agent"] as const).map(
        (id) =>
          choice(id, {
            kind: "list",
            items: picker === id ? choiceItems : [],
            zero: id === "configure-agent" ? "given" : "pin-current",
          }),
      ),
    ];
  }, [
    agents.length,
    defaultAgentId,
    actionAvailability,
    modelRows,
    picker,
    choiceItems,
  ]);
  return modes;
}
