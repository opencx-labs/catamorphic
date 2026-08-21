import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useState,
} from "react";
import { desktopApi, type OpenRouterCatalog } from "../lib/desktop-api.js";

interface OpenRouterRow {
  key: string;
  /** "" selects the synthetic best-free entry (resolved dynamically). */
  modelId: string;
  title: string;
  detail: string;
  free: boolean;
}

/**
 * Searchable model picker for OpenRouter agents. The mono input is both the
 * stored value and the search box; a dropdown below it filters the catalog
 * while focused. An empty model means "current best free model", surfaced
 * as the synthetic first row. If the catalog can't load, degrades to the
 * plain text input. Shared by Settings and the configure-agent modal.
 */
export function OpenRouterModelField({
  value,
  onChange,
}: {
  value: string;
  onChange: (model: string) => void;
}) {
  const [catalog, setCatalog] = useState<OpenRouterCatalog | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let cancelled = false;
    desktopApi
      .openrouterModels()
      .then((data) => {
        if (!cancelled) setCatalog(data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const query = value.trim().toLowerCase();
  const bestId = catalog?.bestFreeModelId ?? null;
  const showBest =
    query === "" ||
    "best free model (automatic)".includes(query) ||
    (bestId?.toLowerCase().includes(query) ?? false);
  const rows: OpenRouterRow[] = catalog
    ? [
        ...(showBest
          ? [
              {
                key: " best",
                modelId: "",
                title: "Best free model (automatic)",
                detail: bestId ?? "no free models right now",
                free: false,
              },
            ]
          : []),
        ...catalog.models
          .filter(
            (m) =>
              m.id.toLowerCase().includes(query) ||
              m.name.toLowerCase().includes(query),
          )
          .sort(
            (a, b) => Number(b.free) - Number(a.free) || b.created - a.created,
          )
          .slice(0, 50)
          .map((m) => ({
            key: m.id,
            modelId: m.id,
            title: m.name,
            detail: m.id,
            free: m.free,
          })),
      ]
    : [];
  const activeIndex = Math.min(active, Math.max(0, rows.length - 1));

  const select = (modelId: string) => {
    onChange(modelId);
    setOpen(false);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
        return;
      }
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActive(Math.min(Math.max(activeIndex + delta, 0), rows.length - 1));
      return;
    }
    if (event.key === "Enter" && open && rows.length > 0) {
      event.preventDefault();
      const row = rows[activeIndex];
      if (row) select(row.modelId);
    }
  };

  if (failed) {
    return (
      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        Model
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Best free model (automatic)"
          className="field h-8 px-2 font-mono text-[13px] text-fg placeholder:font-sans placeholder:text-fg-faint"
          spellCheck={false}
        />
        <span className="text-fg-faint">Couldn't load the model list.</span>
      </label>
    );
  }

  return (
    <div className="flex flex-col gap-1 text-xs text-fg-muted">
      Model
      <div className="relative">
        <input
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          placeholder={`Best free model (${bestId ?? "automatic"})`}
          aria-label="Model"
          className="field h-8 w-full px-2 font-mono text-[13px] text-fg placeholder:font-sans placeholder:text-fg-faint"
          spellCheck={false}
          autoComplete="off"
        />
        {open && (
          <div className="absolute inset-x-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-bg-overlay py-1">
            {!catalog ? (
              <p className="animate-pulse px-2.5 py-1.5 text-[13px] text-fg-muted">
                Loading models…
              </p>
            ) : rows.length === 0 ? (
              <p className="px-2.5 py-1.5 text-[13px] text-fg-faint">
                No models match — the typed id is used as-is.
              </p>
            ) : (
              rows.map((row, index) => (
                <button
                  key={row.key}
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    select(row.modelId);
                  }}
                  onMouseEnter={() => setActive(index)}
                  className={`flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left transition-colors duration-150 ${
                    index === activeIndex ? "bg-bg-inset" : ""
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-fg">
                      {row.title}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-fg-faint">
                      {row.detail}
                    </span>
                  </span>
                  {row.free && (
                    <span className="shrink-0 rounded border border-border-strong px-1 text-[10px] text-fg-muted">
                      free
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        )}
      </div>
      <span className="text-fg-faint">
        Leave empty to always use the current best free model.
      </span>
    </div>
  );
}
