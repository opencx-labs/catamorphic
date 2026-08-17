/** A small pill group — one active choice, no layout shift on change. */
export function Segmented({
  value,
  options,
  onChange,
  testId,
}: {
  value: string;
  options: Array<{ value: string; label: string; title?: string }>;
  onChange: (value: string) => void;
  testId?: string;
}) {
  return (
    <div
      className="flex shrink-0 rounded-md border border-border bg-bg-inset p-0.5"
      data-testid={testId}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={`h-5 cursor-pointer rounded px-1.5 text-[10px] font-medium transition-colors duration-100 ${
              active
                ? "bg-bg-overlay text-fg"
                : "text-fg-faint hover:text-fg-muted"
            }`}
            data-value={option.value}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
