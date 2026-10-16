import { useId, useRef, useState } from "react";
import type { SidebarActionInput } from "../../shared/sidebar.js";
import { Modal } from "./modal.js";
import { PendingButton } from "./pending-button.js";

/**
 * What an action asks for before it runs (ADR 0234): up to four text
 * values, then the action itself. It stays open with the error when the
 * action refuses what was typed, and closes once it has run.
 */
export function ActionInputDialog({
  request,
  onClose,
}: {
  request: {
    label: string;
    input: SidebarActionInput;
    run: (values: Record<string, string>) => Promise<unknown>;
  } | null;
  onClose: () => void;
}) {
  // The dialog fades out with the form it showed, not an emptied panel.
  const last = useRef(request);
  if (request) last.current = request;
  const shown = request ?? last.current;
  return (
    <Modal open={request !== null} onClose={onClose} width={400}>
      {shown && (
        <ActionInputForm
          key={JSON.stringify(shown.input)}
          request={shown}
          onClose={onClose}
        />
      )}
    </Modal>
  );
}

function ActionInputForm({
  request,
  onClose,
}: {
  request: NonNullable<Parameters<typeof ActionInputDialog>[0]["request"]>;
  onClose: () => void;
}) {
  const titleId = useId();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      request.input.fields.map((field) => [field.name, field.value ?? ""]),
    ),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await request.run(values);
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : `Could not ${request.label.toLowerCase()}.`,
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-4 p-5"
      aria-labelledby={titleId}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h2 id={titleId} className="text-base font-semibold text-balance">
        {request.input.title ?? request.label}
      </h2>
      {request.input.fields.map((field, index) => (
        <label key={field.name} className="flex flex-col gap-1.5 text-sm">
          {field.label}
          <input
            name={field.name}
            value={values[field.name] ?? ""}
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                [field.name]: event.target.value,
              }))
            }
            placeholder={field.placeholder}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            // biome-ignore lint/a11y/noAutofocus: the dialog opens to fill its first value
            autoFocus={index === 0}
            className="field h-8 rounded-md px-2 text-sm"
          />
        </label>
      ))}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="button-ghost">
          Cancel
        </button>
        <PendingButton
          type="submit"
          pending={pending}
          className="button-primary"
        >
          {request.input.submit ?? "Save"}
        </PendingButton>
      </div>
    </form>
  );
}
