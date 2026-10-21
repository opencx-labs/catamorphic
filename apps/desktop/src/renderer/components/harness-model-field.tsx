import { useEffect, useState } from "react";
import {
  defaultModelLabel,
  modelLabel,
  sameModel,
} from "../lib/agent-default-model.js";
import {
  type AgentInfo,
  desktopApi,
  type HarnessModelInfo,
} from "../lib/desktop-api.js";

/** The select's value for "type a model id". */
const OTHER = "\0other";

/**
 * The agent's model, picked from what its harness says it supports: Claude
 * Code's own catalog, Codex's (the models a ChatGPT sign-in or OpenAI key
 * can run), or the provider's for a built-in agent. Empty runs the harness
 * default; a built-in agent on Anthropic or OpenAI keys has none, so it
 * offers none. "Other model" takes any id; a model the catalog does not list
 * stays as typed. Without a catalog, the plain field.
 */
export function HarnessModelField({
  agent,
  value,
  onChange,
  placeholder,
  hint,
}: {
  agent: Pick<AgentInfo, "id" | "harness" | "provider">;
  value: string;
  onChange: (model: string) => void;
  placeholder?: string;
  hint: string;
}) {
  const [models, setModels] = useState<HarnessModelInfo[] | null>(null);
  const [error, setError] = useState<string>();
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setModels(null);
    setError(undefined);
    desktopApi
      .agentModels(agent.id)
      .then((result) => {
        if (cancelled) return;
        setModels(result.models);
        setError(result.error);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id]);

  const listed = models?.some((model) => sameModel(model.id, value)) ?? false;
  const custom = typing || (value !== "" && !listed);
  const field = (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className="field h-8 px-2 font-mono text-[13px] text-fg placeholder:font-sans placeholder:text-fg-faint"
      spellCheck={false}
      aria-label="Model id"
      data-testid="agent-model-input"
    />
  );
  // No catalog to pick from: the model is typed.
  if (models !== null && models.length === 0)
    return (
      <div className="flex flex-col gap-1 text-xs text-fg-muted">
        <span aria-hidden>Model</span>
        {field}
        <span className="text-fg-faint">{error ?? hint}</span>
      </div>
    );
  return (
    <div className="flex flex-col gap-1 text-xs text-fg-muted">
      <label className="flex flex-col gap-1">
        Model
        <select
          value={
            custom
              ? OTHER
              : (models?.find((model) => sameModel(model.id, value))?.id ??
                value)
          }
          disabled={models === null}
          data-disabled-reason="Loading the models this agent can run"
          onChange={(event) => {
            const next = event.target.value;
            setTyping(next === OTHER);
            if (next !== OTHER) onChange(next);
          }}
          className="field h-8 px-2 text-[13px] text-fg"
          data-testid="agent-model"
        >
          {models === null ? (
            <option value={value}>Loading models…</option>
          ) : (
            <>
              {/* A built-in agent on Anthropic or OpenAI keys runs only a
                  model it is given: no default to offer, only a prompt. */}
              {agent.harness === "ai-sdk" ? (
                value === "" && (
                  <option value="" disabled>
                    Choose a model
                  </option>
                )
              ) : (
                <option value="">{defaultModelLabel(agent, null)}</option>
              )}
              {models.map((model) => {
                const label = modelLabel(model, models);
                return (
                  <option key={model.id} value={model.id}>
                    {label.detail
                      ? `${label.title} (${label.detail})`
                      : label.title}
                  </option>
                );
              })}
              <option value={OTHER}>Other model…</option>
            </>
          )}
        </select>
      </label>
      {custom && field}
      <span className="text-fg-faint">{hint}</span>
    </div>
  );
}
