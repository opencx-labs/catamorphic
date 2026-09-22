import { Search, Settings, SlidersHorizontal } from "lucide-react";
import { Fragment, useMemo, useRef, useState } from "react";
import type { SiteSummary } from "../../shared/site-settings.js";
import {
  customizedKinds,
  SITE_PERMISSIONS,
} from "../../shared/site-settings.js";
import { ShortcutHint } from "../components/shortcut-hint.js";
import { SiteFavicon } from "../components/site-favicon.js";
import { useListMotion } from "../lib/list-motion.js";
import { SITE_PERMISSION_ICONS, useSites } from "../lib/site-settings.js";
import { useWorkspace } from "../lib/workspace-context.js";

function visitLabel(time: number | null): string {
  if (!time) return "";
  const date = new Date(time);
  const today = new Date();
  if (date.toDateString() === today.toDateString())
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

/**
 * Every site this profile has settings or data for (ADR 0150): sites with
 * a custom permission first, then by last visit. A row opens the same
 * site settings modal the toolbar gear does.
 */
export function SitesScreen({
  active = true,
  onOpenSite,
}: {
  active?: boolean;
  onOpenSite: (origin: string) => void;
}) {
  const runtime = useWorkspace();
  const { sites, error, refresh } = useSites(runtime.visible && active);
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return (sites ?? []).filter((site) =>
      words.every((word) => site.host.toLowerCase().includes(word)),
    );
  }, [sites, query]);
  const list = useRef<HTMLDivElement>(null);
  useListMotion(list, filtered.map(({ origin }) => origin).join("\n"));
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="sites-page">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <SlidersHorizontal className="size-4 text-fg-muted" />
        <h1 className="min-w-0 flex-1 text-sm font-medium text-fg">Sites</h1>
        <label className="field flex h-7 w-56 items-center gap-2 rounded-full px-3">
          <Search className="size-3.5 shrink-0 text-fg-faint" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter sites"
            aria-label="Filter sites"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-fg outline-none placeholder:text-fg-faint"
          />
        </label>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6">
        <div ref={list} className="mx-auto max-w-3xl">
          {filtered.map((site, index) => {
            // Sites with a choice made lead; the heading marks the seam.
            const group = groupOf(site);
            const previous = filtered[index - 1];
            return (
              <Fragment key={site.origin}>
                {(index === 0 || groupOf(previous) !== group) && (
                  <h2 className="pb-2 pt-5 text-xs font-medium text-fg-muted">
                    {group === "custom"
                      ? "Custom permissions"
                      : "Visited and stored data"}
                  </h2>
                )}
                <SiteRow site={site} onOpen={() => onOpenSite(site.origin)} />
              </Fragment>
            );
          })}
          {filtered.length === 0 && (
            <p className="py-16 text-center text-[13px] text-fg-muted">
              {!sites
                ? (error ?? "Reading sites…")
                : query
                  ? "No site matches."
                  : "Sites you visit will appear here with their permissions and data."}
            </p>
          )}
          {error && sites && (
            <p role="alert" className="mt-3 text-xs text-danger">
              {error}{" "}
              <button
                type="button"
                onClick={() => void refresh()}
                className="text-fg-muted underline"
              >
                Try again
              </button>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

const groupOf = (site: SiteSummary | undefined): "custom" | "rest" =>
  site && customizedKinds(site.permissions).length > 0 ? "custom" : "rest";

function SiteRow({ site, onOpen }: { site: SiteSummary; onOpen: () => void }) {
  const customized = customizedKinds(site.permissions);
  const detail = [
    site.cookies > 0
      ? `${site.cookies} ${site.cookies === 1 ? "cookie" : "cookies"}`
      : null,
    customized.length === 0 && site.cookies === 0 ? "No data" : null,
  ].filter(Boolean);
  return (
    <div
      data-item-id={site.origin}
      data-testid="site-row"
      className="group flex min-w-0 items-center gap-1 rounded-md transition-colors duration-150 hover:bg-bg-overlay focus-within:bg-bg-overlay"
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-left"
      >
        <SiteFavicon
          url={site.origin}
          faviconUrl={site.faviconUrl}
          className="size-4 shrink-0"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-fg">
            {site.host}
          </span>
          <span className="flex flex-wrap items-center gap-1.5 text-xs text-fg-faint">
            {detail.length > 0 && <span className="truncate">{detail}</span>}
            {customized.map((kind) => {
              const Icon = SITE_PERMISSION_ICONS[kind];
              const allowed = site.permissions[kind] === "allow";
              return (
                <span
                  key={kind}
                  className={`inline-flex h-4 items-center gap-1 rounded-full border px-1.5 text-[10px] ${
                    allowed
                      ? "border-success/40 text-success"
                      : "border-danger/40 text-danger"
                  }`}
                  data-testid={`site-row-${kind}-${allowed ? "allow" : "block"}`}
                >
                  <Icon className="size-2.5" />
                  {SITE_PERMISSIONS[kind].label}{" "}
                  {allowed ? "allowed" : "blocked"}
                </span>
              );
            })}
          </span>
        </span>
        {site.lastVisitAt && (
          <time
            dateTime={new Date(site.lastVisitAt).toISOString()}
            className="shrink-0 text-[11px] tabular-nums text-fg-faint"
          >
            {visitLabel(site.lastVisitAt)}
          </time>
        )}
      </button>
      <ShortcutHint label="Site settings">
        <button
          type="button"
          aria-label={`Settings for ${site.host}`}
          onClick={onOpen}
          className="row-reveal mr-1 grid size-7 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-bg-raised"
        >
          <Settings className="size-3.5" />
        </button>
      </ShortcutHint>
    </div>
  );
}
