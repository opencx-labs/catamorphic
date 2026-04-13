import type { ParameterInfo } from "@catamorphic/parser";
import { useCallback, useState } from "react";
import { friendlyParamName, friendlyType } from "./display-utils.js";

export interface RunTriggerDialogProps {
  parameters: ParameterInfo[];
  isRunning: boolean;
  initialValues?: Record<string, unknown>;
  onRun: (triggerData: Record<string, unknown>) => void;
  onClose: () => void;
}

function defaultForType(type: string, defaultValue?: string): unknown {
  if (defaultValue != null) {
    if (type === "number") return Number(defaultValue) || 0;
    if (type === "boolean") return defaultValue === "true";
    const unquoted = defaultValue.replace(/^['"]|['"]$/g, "");
    if (unquoted !== defaultValue) return unquoted;
    return defaultValue;
  }
  if (type === "number") return 0;
  if (type === "boolean") return false;
  return "";
}

function ParameterField({
  param,
  value,
  onChange,
}: {
  param: ParameterInfo;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const label = param.displayName ?? friendlyParamName(param.name);
  const typeLabel = friendlyType(param.type);

  if (param.type === "boolean") {
    return (
      <label className="catamorphic-run-field">
        <div className="catamorphic-run-field-header">
          <span className="catamorphic-run-field-label">{label}</span>
          <span className="catamorphic-run-field-type">{typeLabel}</span>
          {param.optional && (
            <span className="catamorphic-run-field-optional">optional</span>
          )}
        </div>
        <div className="catamorphic-run-checkbox-row">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            className="catamorphic-run-checkbox"
          />
          <span className="catamorphic-run-checkbox-label">
            {value ? "Yes" : "No"}
          </span>
        </div>
        {param.description && (
          <span className="catamorphic-run-field-desc">
            {param.description}
          </span>
        )}
      </label>
    );
  }

  if (param.type === "number") {
    return (
      <label className="catamorphic-run-field">
        <div className="catamorphic-run-field-header">
          <span className="catamorphic-run-field-label">{label}</span>
          <span className="catamorphic-run-field-type">{typeLabel}</span>
          {param.optional && (
            <span className="catamorphic-run-field-optional">optional</span>
          )}
        </div>
        <input
          type="number"
          value={String(value ?? "")}
          onChange={(e) => onChange(Number(e.target.value) || 0)}
          className="catamorphic-run-input"
          placeholder={param.name}
        />
        {param.description && (
          <span className="catamorphic-run-field-desc">
            {param.description}
          </span>
        )}
      </label>
    );
  }

  if (param.type === "string") {
    return (
      <label className="catamorphic-run-field">
        <div className="catamorphic-run-field-header">
          <span className="catamorphic-run-field-label">{label}</span>
          <span className="catamorphic-run-field-type">{typeLabel}</span>
          {param.optional && (
            <span className="catamorphic-run-field-optional">optional</span>
          )}
        </div>
        <input
          type="text"
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          className="catamorphic-run-input"
          placeholder={param.name}
        />
        {param.description && (
          <span className="catamorphic-run-field-desc">
            {param.description}
          </span>
        )}
      </label>
    );
  }

  return (
    <label className="catamorphic-run-field">
      <div className="catamorphic-run-field-header">
        <span className="catamorphic-run-field-label">{label}</span>
        <span className="catamorphic-run-field-type">{typeLabel}</span>
        {param.optional && (
          <span className="catamorphic-run-field-optional">optional</span>
        )}
      </div>
      <textarea
        value={
          typeof value === "string" ? value : JSON.stringify(value, null, 2)
        }
        onChange={(e) => {
          try {
            onChange(JSON.parse(e.target.value) as unknown);
          } catch {
            onChange(e.target.value);
          }
        }}
        className="catamorphic-run-textarea"
        placeholder={`JSON for ${param.name}`}
        rows={3}
      />
      {param.description && (
        <span className="catamorphic-run-field-desc">{param.description}</span>
      )}
    </label>
  );
}

export function RunTriggerDialog({
  parameters,
  isRunning,
  initialValues,
  onRun,
  onClose,
}: RunTriggerDialogProps) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {};
    for (const param of parameters) {
      initial[param.name] =
        initialValues?.[param.name] ??
        defaultForType(param.type, param.defaultValue);
    }
    return initial;
  });

  const [jsonMode, setJsonMode] = useState(false);
  const [rawJson, setRawJson] = useState(() => JSON.stringify(values, null, 2));

  const handleSubmit = useCallback(() => {
    if (jsonMode) {
      try {
        onRun(JSON.parse(rawJson) as Record<string, unknown>);
      } catch {
        onRun(values);
      }
    } else {
      onRun(values);
    }
  }, [jsonMode, rawJson, values, onRun]);

  const handleFieldChange = useCallback(
    (name: string, value: unknown) => {
      const next = { ...values, [name]: value };
      setValues(next);
      setRawJson(JSON.stringify(next, null, 2));
    },
    [values],
  );

  const handleOverlayKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss pattern
    <div
      className="catamorphic-run-overlay"
      onClick={onClose}
      onKeyDown={handleOverlayKeyDown}
    >
      <div
        className="catamorphic-run-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Run workflow"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="catamorphic-run-dialog-header">
          <h3 className="catamorphic-run-dialog-title">Run Workflow</h3>
          <button
            type="button"
            className="catamorphic-detail-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="catamorphic-run-dialog-body">
          {parameters.length > 0 && (
            <div className="catamorphic-run-mode-toggle">
              <button
                type="button"
                className={`catamorphic-run-mode-btn ${!jsonMode ? "catamorphic-run-mode-btn-active" : ""}`}
                onClick={() => setJsonMode(false)}
              >
                Form
              </button>
              <button
                type="button"
                className={`catamorphic-run-mode-btn ${jsonMode ? "catamorphic-run-mode-btn-active" : ""}`}
                onClick={() => {
                  setRawJson(JSON.stringify(values, null, 2));
                  setJsonMode(true);
                }}
              >
                JSON
              </button>
            </div>
          )}

          {jsonMode ? (
            <textarea
              value={rawJson}
              onChange={(e) => setRawJson(e.target.value)}
              className="catamorphic-run-json-editor"
              rows={12}
              spellCheck={false}
            />
          ) : parameters.length > 0 ? (
            <div className="catamorphic-run-fields">
              {parameters.map((param) => (
                <ParameterField
                  key={param.name}
                  param={param}
                  value={values[param.name]}
                  onChange={(v) => handleFieldChange(param.name, v)}
                />
              ))}
            </div>
          ) : (
            <p className="catamorphic-run-no-params">
              This workflow has no input parameters.
            </p>
          )}
        </div>

        <div className="catamorphic-run-dialog-footer">
          <button
            type="button"
            className="catamorphic-toolbar-btn"
            onClick={onClose}
            disabled={isRunning}
          >
            Cancel
          </button>
          <button
            type="button"
            className="catamorphic-toolbar-btn catamorphic-toolbar-run"
            onClick={handleSubmit}
            disabled={isRunning}
          >
            {isRunning ? "Running..." : "▶ Run"}
          </button>
        </div>
      </div>
    </div>
  );
}
