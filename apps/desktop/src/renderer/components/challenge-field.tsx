import { useId } from "react";

/** One field of a connection provider's form challenge. */
export interface ChallengeFormField {
  name: string;
  label: string;
  secret: boolean;
  required: boolean;
  multiline?: boolean;
}

/**
 * A provider form field: a text area when the value spans lines (a PEM key
 * or a JSON document, which a single-line input would flatten), otherwise
 * a text or password input.
 */
export function ChallengeField({
  field,
  value,
  onChange,
}: {
  field: ChallengeFormField;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-fg-muted">
        {field.label}
      </label>
      {field.multiline ? (
        <textarea
          id={id}
          name={field.name}
          required={field.required}
          autoComplete="off"
          spellCheck={false}
          rows={6}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="field w-full resize-y rounded-md px-2.5 py-2 font-mono text-[12px] leading-4"
        />
      ) : (
        <input
          id={id}
          name={field.name}
          type={field.secret ? "password" : "text"}
          required={field.required}
          autoComplete="off"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="field h-8 w-full rounded-md px-2.5 text-[13px]"
        />
      )}
    </div>
  );
}
