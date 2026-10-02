"use client";

import type {
  JsonValue,
  RuntimeRequest,
  RuntimeRequestResponse,
} from "@catamorphic/react";
import { ExternalLink, ShieldQuestionMark } from "lucide-react";
import { useState } from "react";

/**
 * A request that is not a question (ADR 0197): an approval to use a tool,
 * or a connector asking for input. Approvals show the tool and exactly
 * what it will send, with Allow once, Always allow (the host keeps it on
 * the connection) and Deny. A request whose agent has gone says why and
 * offers nothing to press; one only named approvers may answer says who.
 */
export function ApprovalCard({
  request,
  onRespond,
  busy = false,
  viewerId,
  approverName = (id) => id,
  onOpenUrl,
  className,
}: {
  request: RuntimeRequest;
  onRespond: (response: RuntimeRequestResponse) => void;
  busy?: boolean;
  /** Who is looking; unknown counts as someone who may answer. */
  viewerId?: string;
  approverName?: (externalUserId: string) => string;
  /** Opens a connector's sign-in page (URL elicitations). */
  onOpenUrl?: (url: string) => void;
  className?: string;
}) {
  const [showArgs, setShowArgs] = useState(false);
  const tool = request.approval?.tool;
  const waitingOnOthers =
    request.approvers.length > 0 &&
    viewerId !== undefined &&
    !request.approvers.includes(viewerId);
  const origin = request.origin.displayName ?? request.origin.id;
  return (
    <div
      className={`mx-3 mb-1 rounded-xl border border-accent/35 bg-bg-overlay/60 p-3 text-sm ${className ?? ""}`}
      data-testid="approval-card"
      data-request-kind={request.kind}
    >
      <div className="mb-2 flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-full border border-border bg-bg-overlay">
          <ShieldQuestionMark className="size-4 text-accent" />
        </span>
        <div className="min-w-0 flex-1">
          {request.kind === "approval" && tool ? (
            <p className="text-[13px] text-fg">
              The agent wants to use{" "}
              <span className="font-medium">{tool.name}</span>
              {tool.server ? (
                <>
                  {" "}
                  on <span className="font-medium">{tool.server}</span>
                </>
              ) : null}
            </p>
          ) : (
            <p className="text-[13px] text-fg">
              {request.kind === "elicitation"
                ? (request.elicitation?.message ?? request.title)
                : (request.approval?.action ?? request.title)}
            </p>
          )}
          {(request.description || request.approval?.details) && (
            <p className="mt-1 line-clamp-3 text-xs text-fg-muted">
              {request.description ?? request.approval?.details}
            </p>
          )}
          {request.kind === "elicitation" && (
            <p className="mt-1 text-[11px] text-fg-faint">From {origin}</p>
          )}
        </div>
      </div>
      {tool && (
        <>
          <button
            type="button"
            onClick={() => setShowArgs((value) => !value)}
            className="mb-1 cursor-pointer text-[11px] text-fg-muted transition-colors duration-150 hover:text-fg"
            aria-expanded={showArgs}
          >
            {showArgs ? "Hide what it sends" : "Show what it sends"}
          </button>
          {showArgs && (
            <pre className="mb-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg-inset p-2 font-mono text-[11px] leading-4 text-fg-muted">
              {JSON.stringify(tool.input, null, 2)}
            </pre>
          )}
        </>
      )}
      {!request.answerable && request.blocking ? (
        <p className="mt-1 text-xs text-fg-muted" role="status">
          {request.reason ??
            "The agent that asked has stopped, so this can no longer be answered."}
        </p>
      ) : waitingOnOthers ? (
        <p className="mt-1 text-xs text-fg-muted" role="status">
          Waiting for {request.approvers.map(approverName).join(", ")}
        </p>
      ) : request.kind === "approval" ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onRespond({ kind: "approval", decision: "approved" })
            }
            className="h-8 cursor-pointer rounded-md bg-accent px-4 text-[13px] font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
            data-testid="approval-allow"
          >
            Allow once
          </button>
          {tool?.server && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                onRespond({
                  kind: "approval",
                  decision: "approved",
                  remember: "always",
                })
              }
              className="h-8 cursor-pointer rounded-md border border-border-strong bg-bg-overlay px-3 text-[13px] text-fg transition-colors duration-150 hover:border-accent disabled:opacity-50"
              data-testid="approval-always"
            >
              Always allow
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => onRespond({ kind: "approval", decision: "denied" })}
            className="ml-auto h-8 cursor-pointer rounded-md px-3 text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg disabled:opacity-50"
            data-testid="approval-deny"
          >
            Deny
          </button>
        </div>
      ) : (
        <ElicitationAnswer
          request={request}
          busy={busy}
          onRespond={onRespond}
          onOpenUrl={onOpenUrl}
        />
      )}
    </div>
  );
}

/** One field a connector asks for, from its JSON Schema. */
interface ElicitationField {
  name: string;
  title: string;
  type: "string" | "number" | "boolean" | "enum";
  required: boolean;
  options: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

/** The fields of a flat elicitation schema; nested ones are not offered. */
function elicitationFields(schema: unknown): ElicitationField[] {
  const properties = record(record(schema)?.properties) ?? {};
  const required = record(schema)?.required;
  const requiredNames = Array.isArray(required) ? required : [];
  return Object.entries(properties).flatMap(([name, raw]) => {
    const property = record(raw);
    if (!property) return [];
    const title = typeof property.title === "string" ? property.title : name;
    const options = Array.isArray(property.enum)
      ? property.enum.filter(
          (option): option is string => typeof option === "string",
        )
      : [];
    const type =
      options.length > 0
        ? "enum"
        : property.type === "number" || property.type === "integer"
          ? "number"
          : property.type === "boolean"
            ? "boolean"
            : property.type === "string"
              ? "string"
              : undefined;
    if (!type) return [];
    return [
      { name, title, type, required: requiredNames.includes(name), options },
    ];
  });
}

/**
 * A connector's request for input: open a page, fill a short form, or
 * just allow (a schema with no fields is a yes or no).
 */
function ElicitationAnswer({
  request,
  busy,
  onRespond,
  onOpenUrl,
}: {
  request: RuntimeRequest;
  busy: boolean;
  onRespond: (response: RuntimeRequestResponse) => void;
  onOpenUrl?: (url: string) => void;
}) {
  const url = request.elicitation?.url;
  const fields = url ? [] : elicitationFields(request.elicitation?.schema);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const missing = fields.some(
    (field) =>
      field.required &&
      field.type !== "boolean" &&
      String(values[field.name] ?? "").trim() === "",
  );
  const content = (): JsonValue => {
    const out: Record<string, JsonValue> = {};
    for (const field of fields) {
      const value = values[field.name];
      if (value === undefined || value === "") continue;
      out[field.name] =
        field.type === "number"
          ? Number(value)
          : field.type === "boolean"
            ? value === true
            : String(value);
    }
    return out;
  };
  return (
    <form
      className="mt-2 flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (url) onOpenUrl?.(url);
        onRespond({
          kind: "elicitation",
          action: "accept",
          ...(url ? {} : { content: content() }),
        });
      }}
    >
      {fields.map((field) => (
        <div key={field.name} className="flex flex-col gap-1 text-xs">
          <label
            htmlFor={`${request.id}:${field.name}`}
            className="text-fg-muted"
          >
            {field.title}
            {field.required ? "" : " (optional)"}
          </label>
          {field.type === "boolean" ? (
            <input
              id={`${request.id}:${field.name}`}
              type="checkbox"
              checked={values[field.name] === true}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  [field.name]: event.target.checked,
                }))
              }
            />
          ) : field.type === "enum" ? (
            <select
              id={`${request.id}:${field.name}`}
              value={String(values[field.name] ?? "")}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  [field.name]: event.target.value,
                }))
              }
              className="rounded-md border border-border bg-bg-inset px-2 py-1 text-[13px] text-fg"
            >
              <option value="">Choose</option>
              {field.options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={`${request.id}:${field.name}`}
              type={field.type === "number" ? "number" : "text"}
              value={String(values[field.name] ?? "")}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  [field.name]: event.target.value,
                }))
              }
              className="rounded-md border border-border bg-bg-inset px-2 py-1 text-[13px] text-fg"
            />
          )}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={busy || missing}
          className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
          data-testid="elicitation-accept"
        >
          {url && <ExternalLink className="size-3.5" />}
          {url ? "Open" : fields.length > 0 ? "Submit" : "Allow"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onRespond({ kind: "elicitation", action: "decline" })}
          className="ml-auto h-8 cursor-pointer rounded-md px-3 text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg disabled:opacity-50"
          data-testid="elicitation-decline"
        >
          Decline
        </button>
      </div>
    </form>
  );
}
