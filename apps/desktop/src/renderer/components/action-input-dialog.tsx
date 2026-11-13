import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  inputDefaults,
  inputFieldVisible,
  submittedInputValues,
} from "../../shared/action-input.js";
import type {
  SidebarActionInput,
  SidebarInputField,
  SidebarInputValues,
} from "../../shared/sidebar.js";
import { motionMs } from "../lib/motion.js";
import { Collapsible } from "./collapsible.js";
import { Modal } from "./modal.js";
import { PendingButton } from "./pending-button.js";

interface TemporalApi {
  PlainDateTime: {
    from: (
      fields: Record<string, number>,
      options: { overflow: "reject" },
    ) => unknown;
  };
  ZonedDateTime: {
    from: (
      fields: Record<string, unknown>,
      options: { disambiguation: "reject"; overflow: "reject" },
    ) => { epochMilliseconds: number };
  };
}
function isTemporalApi(value: unknown): value is TemporalApi {
  if (
    typeof value !== "object" ||
    value === null ||
    !("ZonedDateTime" in value) ||
    !("PlainDateTime" in value)
  )
    return false;
  const zoned = value.ZonedDateTime;
  const plain = value.PlainDateTime;
  return (
    typeof plain === "function" &&
    "from" in plain &&
    typeof plain.from === "function" &&
    typeof zoned === "function" &&
    "from" in zoned &&
    typeof zoned.from === "function"
  );
}

/** Host-rendered forms share Work's controls, validation and focus restoration. */
export function ActionInputDialog({
  request,
  requestKey,
  onClose,
  selectInitialValue = false,
}: {
  request: {
    label: string;
    input: SidebarActionInput;
    run: (values: SidebarInputValues) => Promise<unknown>;
  } | null;
  /** Stable identity for callers that construct the request during rendering. */
  requestKey?: string | object;
  onClose: () => void;
  selectInitialValue?: boolean;
}) {
  const titleId = useId();
  const identity = request ? (requestKey ?? request) : null;
  const generation = useRef({ request: identity, epoch: 0 });
  if (identity !== generation.current.request) {
    generation.current = {
      request: identity,
      epoch: generation.current.epoch + (request ? 1 : 0),
    };
  }
  const epoch = generation.current.epoch;
  const last = useRef(request);
  if (request) last.current = request;
  const shown = request ?? last.current;
  return (
    <Modal
      open={request !== null}
      onClose={onClose}
      width={440}
      labelledBy={titleId}
      animateSize
    >
      {shown && (
        <ActionInputForm
          key={epoch}
          request={shown}
          titleId={titleId}
          onClose={() => {
            if (
              generation.current.request !== null &&
              generation.current.epoch === epoch
            )
              onClose();
          }}
          active={request !== null}
          selectInitialValue={selectInitialValue}
        />
      )}
    </Modal>
  );
}

/** Calendar-only controls stay strings; datetime controls cross as ISO instants. */
export function localDateTime(instant: string): string {
  const d = new Date(instant);
  if (!instant || !Number.isFinite(d.getTime())) return "";
  const pad = (n: number, size = 2) => String(n).padStart(size, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}${d.getSeconds() || d.getMilliseconds() ? `:${pad(d.getSeconds())}${d.getMilliseconds() ? `.${pad(d.getMilliseconds(), 3)}` : ""}` : ""}`;
}
export function dateTimeInstant(local: string): string {
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
      local,
    );
  if (!parts) throw Error("Choose a valid date and time.");
  const [year, month, day, hour, minute, second, millisecond] = [
    Number(parts[1]),
    Number(parts[2]),
    Number(parts[3]),
    Number(parts[4]),
    Number(parts[5]),
    Number(parts[6] ?? 0),
    Number((parts[7] ?? "").padEnd(3, "0")),
  ];
  const temporal: unknown = Reflect.get(globalThis, "Temporal");
  if (isTemporalApi(temporal)) {
    const fields = { year, month, day, hour, minute, second, millisecond };
    // Calendar overflow is different from a timezone gap or fold.
    try {
      temporal.PlainDateTime.from(fields, { overflow: "reject" });
    } catch {
      throw Error("This local time does not exist. Choose another time.");
    }
    try {
      return new Date(
        temporal.ZonedDateTime.from(
          {
            ...fields,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
          { disambiguation: "reject", overflow: "reject" },
        ).epochMilliseconds,
      ).toISOString();
    } catch {
      throw Error(
        "This local time is skipped or occurs twice when the clocks change. Choose another time.",
      );
    }
  }
  // DOM tests and older embedders may lack Temporal; verify every component and
  // look for a second matching instant across all modern timezone transitions.
  const date = new Date(local);
  if (
    !Number.isFinite(date.getTime()) ||
    [
      date.getFullYear(),
      date.getMonth() + 1,
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
      date.getSeconds(),
      date.getMilliseconds(),
    ].some(
      (v, i) => v !== [year, month, day, hour, minute, second, millisecond][i],
    )
  )
    throw Error("This local time does not exist. Choose another time.");
  const canonical = localDateTime(date.toISOString());
  for (let offset = -1560; offset <= 1560; offset += 30)
    if (
      offset !== 0 &&
      localDateTime(new Date(date.getTime() + offset * 60000).toISOString()) ===
        canonical
    )
      throw Error(
        "This local time occurs twice when the clocks change. Choose an unambiguous time.",
      );
  return date.toISOString();
}
function localInputDefaults(
  fields: SidebarInputField[],
  initial: SidebarInputValues = {},
): SidebarInputValues {
  const values = inputDefaults(fields, initial);
  return Object.fromEntries(
    fields.map((f) => {
      const value = values[f.name];
      return [
        f.name,
        f.type === "datetime"
          ? localDateTime(String(value ?? ""))
          : f.type === "repeat"
            ? (Array.isArray(value) ? value : []).map((v) =>
                localInputDefaults(f.fields, v),
              )
            : (value ?? null),
      ];
    }),
  );
}

function ActionInputForm({
  request,
  titleId,
  onClose,
  active,
  selectInitialValue,
}: {
  request: NonNullable<Parameters<typeof ActionInputDialog>[0]["request"]>;
  titleId: string;
  onClose: () => void;
  active: boolean;
  selectInitialValue: boolean;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState(() =>
    localInputDefaults(request.input.fields),
  );
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string>();
  const lastError = useRef(error);
  if (error) lastError.current = error;
  useEffect(() => {
    if (!active) return;
    const first = [
      ...(form.current?.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >("input,textarea,select") ?? []),
    ].find((field) => !field.matches(":disabled") && !field.closest("[inert]"));
    first?.focus({ preventScroll: true });
    if (
      selectInitialValue &&
      first instanceof HTMLInputElement &&
      first.type === "text"
    )
      first.select();
  }, [active, selectInitialValue]);
  return (
    <form
      ref={form}
      data-action-input
      className="flex flex-col gap-4 p-5"
      aria-labelledby={titleId}
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending) return;
        setPending(true);
        setError(undefined);
        try {
          const submitted = submittedInputValues(request.input.fields, values);
          const convert = (
            fields: SidebarInputField[],
            object: SidebarInputValues,
          ): SidebarInputValues =>
            Object.fromEntries(
              Object.entries(object).map(([name, value]) => {
                const field = fields.find((f) => f.name === name);
                return [
                  name,
                  field?.type === "datetime" &&
                  typeof value === "string" &&
                  value
                    ? dateTimeInstant(value)
                    : field?.type === "repeat" && Array.isArray(value)
                      ? value.map((v) => convert(field.fields, v))
                      : value,
                ];
              }),
            );
          await request.run(convert(request.input.fields, submitted));
          onClose();
        } catch (cause) {
          setError(
            cause instanceof Error
              ? cause.message
              : `Could not ${request.label.toLowerCase()}.`,
          );
        } finally {
          setPending(false);
        }
      }}
    >
      <h2 id={titleId} className="text-base font-semibold text-balance">
        {request.input.title ?? request.label}
      </h2>
      <fieldset disabled={pending} className="flex min-w-0 flex-col">
        <Fields
          fields={request.input.fields}
          values={values}
          onChange={setValues}
        />
        <Collapsible open={Boolean(error)}>
          <p role="alert" className="pt-4 text-sm text-danger">
            {lastError.current}
          </p>
        </Collapsible>
      </fieldset>
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

function Fields({
  fields,
  values,
  onChange,
  prefix = "",
}: {
  fields: SidebarInputField[];
  values: SidebarInputValues;
  onChange: (values: SidebarInputValues) => void;
  prefix?: string;
}) {
  return (
    <>
      {fields.map((f, index) => (
        <Collapsible key={f.name} open={inputFieldVisible(f, values)}>
          <fieldset
            disabled={!inputFieldVisible(f, values)}
            className={
              fields
                .slice(0, index)
                .some((field) => inputFieldVisible(field, values))
                ? "min-w-0 pt-4"
                : "min-w-0"
            }
          >
            <Field
              field={f}
              value={values[f.name]}
              onChange={(value) => onChange({ ...values, [f.name]: value })}
              name={`${prefix}${f.name}`}
            />
          </fieldset>
        </Collapsible>
      ))}
    </>
  );
}
function Field({
  field: f,
  value,
  onChange,
  name,
}: {
  field: SidebarInputField;
  value: SidebarInputValues[string] | undefined;
  onChange: (value: SidebarInputValues[string]) => void;
  name: string;
}) {
  const id = useId();
  if (f.type === "repeat")
    return (
      <RepeatedFields
        field={f}
        values={Array.isArray(value) ? value : []}
        onChange={onChange}
        name={name}
      />
    );
  const className = "field min-w-0 w-full rounded-md px-2 text-sm";
  const common = {
    id,
    name,
    required: f.required,
    "aria-describedby": f.description ? `${id}-help` : undefined,
  };
  let control: ReactNode;
  if (f.type === "select")
    control = (
      <select
        {...common}
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        className={`${className} h-8`}
      >
        {f.options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    );
  else if (f.type === "checkbox")
    control = (
      <input
        {...common}
        type="checkbox"
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  else if (f.type === "textarea")
    control = (
      <textarea
        {...common}
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        placeholder={f.placeholder}
        minLength={f.minLength}
        maxLength={f.maxLength ?? 8192}
        rows={3}
        className={`${className} py-2`}
      />
    );
  else
    control = (
      <input
        {...common}
        type={f.type === "datetime" ? "datetime-local" : (f.type ?? "text")}
        value={typeof value === "number" ? value : String(value ?? "")}
        onChange={(e) =>
          onChange(
            f.type === "number"
              ? e.target.value === ""
                ? null
                : e.target.valueAsNumber
              : e.target.value,
          )
        }
        placeholder={f.placeholder}
        min={f.type === "number" ? f.min : undefined}
        max={f.type === "number" ? f.max : undefined}
        step={
          f.type === "number"
            ? (f.step ?? "any")
            : f.type === "datetime"
              ? "any"
              : undefined
        }
        minLength={"minLength" in f ? f.minLength : undefined}
        maxLength={"maxLength" in f ? (f.maxLength ?? 8192) : undefined}
        className={`${className} h-8`}
      />
    );
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-sm">
      <label
        htmlFor={id}
        className={
          f.type === "checkbox" ? "flex items-center gap-2" : undefined
        }
      >
        {f.type === "checkbox" ? (
          <>
            {control}
            {f.label}
          </>
        ) : (
          f.label
        )}
        {f.required && <span className="sr-only"> (required)</span>}
      </label>
      {f.type !== "checkbox" && control}
      {f.type === "datetime" && (
        <p className="text-xs text-fg-muted">
          {Intl.DateTimeFormat().resolvedOptions().timeZone}
        </p>
      )}
      {f.description && (
        <p id={`${id}-help`} className="text-xs text-fg-muted">
          {f.description}
        </p>
      )}
    </div>
  );
}
function RepeatedFields({
  field,
  values,
  onChange,
  name,
}: {
  field: Extract<SidebarInputField, { type: "repeat" }>;
  values: SidebarInputValues[];
  onChange: (values: SidebarInputValues[]) => void;
  name: string;
}) {
  const next = useRef(0),
    [keys, setKeys] = useState(() => values.map(() => next.current++));
  const [entered, setEntered] = useState(() => new Set(keys));
  const [leaving, setLeaving] = useState<
    Array<{ key: number; value: SidebarInputValues; index: number }>
  >([]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(new Set(keys)));
    return () => cancelAnimationFrame(frame);
  }, [keys]);
  useEffect(() => {
    if (!leaving.length) return;
    const timer = setTimeout(() => setLeaving([]), motionMs(200) + 32);
    return () => clearTimeout(timer);
  }, [leaving]);
  const entries = [
    ...values.flatMap((value, index) => {
      const key = keys[index];
      return key === undefined ? [] : [{ key, value, index, leaving: false }];
    }),
    ...leaving.map((entry) => ({ ...entry, leaving: true })),
  ].sort((a, b) => a.key - b.key);
  const root = useRef<HTMLFieldSetElement>(null),
    focusNew = useRef<"entry" | "add" | null>(null);
  useEffect(() => {
    if (focusNew.current) {
      if (focusNew.current === "entry" && !entered.has(keys.at(-1) ?? -1))
        return;
      const selector =
        focusNew.current === "add"
          ? "[data-repeat-add]"
          : `[data-repeat-key="${keys.at(-1)}"] input,[data-repeat-key="${keys.at(-1)}"] select`;
      focusNew.current = null;
      root.current?.querySelector<HTMLElement>(selector)?.focus();
    }
  }, [keys, entered]);
  return (
    <fieldset ref={root} className="flex min-w-0 flex-col">
      <legend className="mb-2 text-sm font-medium">{field.label}</legend>
      {field.description && (
        <p className="text-xs text-fg-muted">{field.description}</p>
      )}
      {entries.map(({ key, value: entry, index, leaving: exiting }) => (
        <Collapsible key={key} open={!exiting && entered.has(key)}>
          <fieldset disabled={exiting} className="min-w-0 pb-3">
            <div
              data-repeat-entry
              data-repeat-key={key}
              className="flex min-w-0 flex-col gap-3 rounded-md border border-border p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-fg-muted">
                  {field.label} {index + 1}
                </span>
                <button
                  type="button"
                  className="button-ghost text-xs"
                  disabled={values.length <= (field.minItems ?? 0)}
                  aria-label={`Remove ${field.label.toLowerCase()} ${index + 1}`}
                  onClick={(event) => {
                    const button = event.currentTarget;
                    setLeaving((rows) => [
                      ...rows,
                      { key, value: entry, index },
                    ]);
                    onChange(values.filter((_, i) => i !== index));
                    setKeys(keys.filter((_, i) => i !== index));
                    if (
                      button.contains(document.activeElement) ||
                      button === document.activeElement
                    )
                      focusNew.current = "add";
                  }}
                >
                  Remove
                </button>
              </div>
              <Fields
                fields={field.fields}
                values={entry}
                onChange={(changed) =>
                  onChange(values.map((v, i) => (i === index ? changed : v)))
                }
                prefix={
                  exiting ? `${name}.exiting-${key}.` : `${name}.${index}.`
                }
              />
            </div>
          </fieldset>
        </Collapsible>
      ))}
      <button
        data-repeat-add
        type="button"
        className="button-ghost self-start"
        disabled={values.length >= (field.maxItems ?? 10)}
        onClick={() => {
          focusNew.current = "entry";
          onChange([...values, localInputDefaults(field.fields)]);
          setKeys([...keys, next.current++]);
        }}
      >
        {field.addLabel ?? `Add ${field.label.toLowerCase()}`}
      </button>
    </fieldset>
  );
}
