import { ExternalLink } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Modal } from "./modal.js";
import { PendingButton } from "./pending-button.js";

/**
 * MCP elicitation (`elicitation/create`): a connector asking the USER
 * something mid-call — a small form, or a URL to open (OAuth/credential
 * handoffs). Rendered here; the answer goes back to the server. Per the
 * spec, form mode never carries secrets (those use URL mode), and a URL
 * is shown in full and opened only on explicit consent.
 */

export interface ElicitFormField {
  name: string;
  type: "string" | "number" | "integer" | "boolean" | "enum";
  title?: string;
  description?: string;
  required: boolean;
  format?: string;
  default?: string | number | boolean;
  options?: Array<{ value: string; label: string }>;
  multiSelect?: boolean;
}

export type ElicitRequest =
  | { mode: "form"; message: string; fields: ElicitFormField[] }
  | { mode: "url"; message: string; url: string };

export type ElicitResult =
  | { action: "accept"; content?: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" };

export interface PendingElicitation {
  id: string;
  label?: string;
  request: ElicitRequest;
  resolve: (result: ElicitResult) => void;
}

export function ElicitationModal({
  pending,
  onOpenUrl,
}: {
  pending: PendingElicitation | null;
  /** URL-mode consent → open the sign-in page as a browser tab. */
  onOpenUrl: (url: string) => void;
}) {
  if (!pending) return null;
  return (
    <Modal open onClose={() => pending.resolve({ action: "cancel" })}>
      <div className="w-[min(440px,90vw)] p-5" data-testid="elicitation-modal">
        {pending.request.mode === "url" ? (
          <UrlElicitation
            label={pending.label}
            request={pending.request}
            onResolve={pending.resolve}
            onOpenUrl={onOpenUrl}
          />
        ) : (
          <FormElicitation
            label={pending.label}
            request={pending.request}
            onResolve={pending.resolve}
          />
        )}
      </div>
    </Modal>
  );
}

function Header({ label, message }: { label?: string; message: string }) {
  return (
    <div className="mb-3">
      {label && (
        <p className="text-[11px] font-medium uppercase tracking-wide text-fg-faint">
          {label}
        </p>
      )}
      <p className="text-[13px] text-fg">{message}</p>
    </div>
  );
}

function UrlElicitation({
  label,
  request,
  onResolve,
  onOpenUrl,
}: {
  label?: string;
  request: Extract<ElicitRequest, { mode: "url" }>;
  onResolve: (result: ElicitResult) => void;
  onOpenUrl: (url: string) => void;
}) {
  return (
    <>
      <Header label={label} message={request.message} />
      <p className="mb-4 truncate rounded-md border border-border bg-bg-inset px-2 py-1.5 font-mono text-[11px] text-fg-muted">
        {request.url}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            onOpenUrl(request.url);
            onResolve({ action: "accept" });
          }}
          className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-accent px-4 text-[13px] font-medium text-accent-fg"
        >
          <ExternalLink className="size-3.5" />
          Open to continue
        </button>
        <button
          type="button"
          onClick={() => onResolve({ action: "decline" })}
          className="h-8 cursor-pointer rounded-md px-3 text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
        >
          Not now
        </button>
      </div>
    </>
  );
}

function FormElicitation({
  label,
  request,
  onResolve,
}: {
  label?: string;
  request: Extract<ElicitRequest, { mode: "form" }>;
  onResolve: (result: ElicitResult) => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {};
    for (const field of request.fields) {
      if (field.default !== undefined) initial[field.name] = field.default;
      if (field.type === "boolean" && field.default === undefined) {
        initial[field.name] = false;
      }
    }
    return initial;
  });

  const missingRequired = request.fields.some((field) => {
    if (!field.required) return false;
    const value = values[field.name];
    return value === undefined || value === "" || value === null;
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (missingRequired) return;
    // Coerce to the field's type; omit empty optionals.
    const content: Record<string, unknown> = {};
    for (const field of request.fields) {
      const raw = values[field.name];
      if (raw === undefined || raw === "") continue;
      if (field.type === "number" || field.type === "integer") {
        const num = Number(raw);
        if (!Number.isNaN(num)) content[field.name] = num;
      } else {
        content[field.name] = raw;
      }
    }
    onResolve({ action: "accept", content });
  };

  return (
    <form onSubmit={submit}>
      <Header label={label} message={request.message} />
      <div className="mb-4 flex flex-col gap-3">
        {request.fields.map((field) => (
          <ElicitField
            key={field.name}
            field={field}
            value={values[field.name]}
            onChange={(value) =>
              setValues((current) => ({ ...current, [field.name]: value }))
            }
          />
        ))}
      </div>
      <div className="flex items-center gap-2">
        <PendingButton
          type="submit"
          pending={false}
          pendingLabel="Submitting…"
          disabled={missingRequired}
          className="h-8 cursor-pointer rounded-md bg-accent px-4 text-[13px] font-medium text-accent-fg disabled:cursor-not-allowed disabled:opacity-50"
        >
          Submit
        </PendingButton>
        <button
          type="button"
          onClick={() => onResolve({ action: "decline" })}
          className="h-8 cursor-pointer rounded-md px-3 text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function ElicitField({
  field,
  value,
  onChange,
}: {
  field: ElicitFormField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const title = field.title ?? field.name;
  const id = `elicit-${field.name}`;
  if (field.type === "boolean") {
    return (
      <label className="flex cursor-pointer items-center gap-2 text-[13px] text-fg">
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>
          {title}
          {field.description && (
            <span className="ml-1 text-fg-faint">— {field.description}</span>
          )}
        </span>
      </label>
    );
  }
  return (
    <div className="flex flex-col gap-1 text-xs text-fg-muted">
      <label htmlFor={id}>
        {title}
        {field.required ? <span className="text-danger"> *</span> : null}
      </label>
      {field.type === "enum" && field.options ? (
        <select
          id={id}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          className="field h-8 px-2 text-[13px] text-fg"
        >
          <option value="" disabled>
            Choose…
          </option>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type={
            field.type === "number" || field.type === "integer"
              ? "number"
              : field.format === "email"
                ? "email"
                : "text"
          }
          value={
            typeof value === "string" || typeof value === "number"
              ? String(value)
              : ""
          }
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.description}
          className="field h-8 px-2 text-[13px] text-fg placeholder:text-fg-faint"
          spellCheck={false}
        />
      )}
    </div>
  );
}
