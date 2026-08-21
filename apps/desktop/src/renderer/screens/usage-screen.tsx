/**
 * The usage page (ADR 0057): tokens and API-equivalent cost across every
 * Claude Code and Codex session on this machine, scanned from the CLIs'
 * own transcripts in main. Deliberately whole-machine, and says so.
 *
 * Chart: stacked bars per period, one segment per provider, hand-rolled
 * SVG. Series colors are fixed by provider (never cycled): Claude Code
 * wears info blue, Codex success green; 2px spacers and the legend carry
 * identity beyond color.
 */
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UsageBucket, UsageProvider } from "../../shared/usage.js";
import { totalTokens } from "../../shared/usage.js";
import { Segmented } from "../components/segmented.js";
import { desktopApi, type UsageSummary } from "../lib/desktop-api.js";

const PROVIDERS: {
  key: UsageProvider;
  label: string;
  colorVar: string;
}[] = [
  { key: "claude", label: "Claude Code", colorVar: "var(--color-info)" },
  { key: "codex", label: "Codex", colorVar: "var(--color-success)" },
];

const RANGE_OPTIONS = [
  { value: "1", label: "24h" },
  { value: "7", label: "7d" },
  { value: "30", label: "30d" },
  { value: "90", label: "90d" },
];

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function formatUsd(value: number): string {
  return usdFormatter.format(value);
}

/** 3 significant figures with K/M/B/T so table columns line up. */
function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  const units = [
    { at: 1e12, suffix: "T" },
    { at: 1e9, suffix: "B" },
    { at: 1e6, suffix: "M" },
    { at: 1e3, suffix: "K" },
  ];
  for (const unit of units) {
    if (value >= unit.at) {
      return `${Number((value / unit.at).toPrecision(3))}${unit.suffix}`;
    }
  }
  return String(value);
}

interface PeriodPoint {
  key: string;
  label: string;
  byProvider: Record<UsageProvider, number>;
}

interface Rollup {
  costUsd: number;
  tokens: number;
  cachedInput: number;
  uncachedInput: number;
  output: number;
  cacheSavingsUsd: number;
  records: number;
  unpricedRecords: number;
  providers: {
    key: UsageProvider;
    label: string;
    colorVar: string;
    costUsd: number;
    tokens: number;
  }[];
  models: {
    provider: UsageProvider;
    model: string;
    costUsd: number;
    tokens: number;
    unpriced: boolean;
  }[];
  periods: PeriodPoint[];
}

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const dayLabelFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const hourLabelFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

/** Every period in the window, empty ones included, so gaps stay visible. */
function enumeratePeriods(summary: UsageSummary): PeriodPoint[] {
  const periods: PeriodPoint[] = [];
  if (summary.resolution === "hour") {
    const HOUR_MS = 60 * 60 * 1000;
    for (
      let start = summary.windowStartMs;
      start < summary.windowEndMs;
      start += HOUR_MS
    ) {
      periods.push({
        key: new Date(start).toISOString(),
        label: hourLabelFormatter.format(new Date(start)),
        byProvider: { claude: 0, codex: 0 },
      });
    }
  } else {
    const cursor = new Date(summary.windowStartMs);
    cursor.setHours(12, 0, 0, 0); // noon: immune to DST hour shifts
    while (cursor.getTime() <= summary.windowEndMs) {
      periods.push({
        key: dayFormatter.format(cursor),
        label: dayLabelFormatter.format(cursor),
        byProvider: { claude: 0, codex: 0 },
      });
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return periods;
}

function rollUp(summary: UsageSummary, metric: "cost" | "tokens"): Rollup {
  const providerTotals = new Map<
    UsageProvider,
    { costUsd: number; tokens: number }
  >();
  const modelTotals = new Map<
    string,
    {
      provider: UsageProvider;
      model: string;
      costUsd: number;
      tokens: number;
      records: number;
      unpricedRecords: number;
    }
  >();
  const periods = enumeratePeriods(summary);
  const periodIndex = new Map(periods.map((period) => [period.key, period]));

  let costUsd = 0;
  let cachedInput = 0;
  let uncachedInput = 0;
  let output = 0;
  let cacheCreation = 0;
  let cacheSavingsUsd = 0;
  let records = 0;
  let unpricedRecords = 0;

  const bucketValue = (bucket: UsageBucket) =>
    metric === "cost" ? bucket.costUsd : totalTokens(bucket.tokens);

  for (const bucket of summary.buckets) {
    costUsd += bucket.costUsd;
    cachedInput += bucket.tokens.cachedInputTokens;
    uncachedInput += bucket.tokens.inputTokens;
    cacheCreation += bucket.tokens.cacheCreationTokens;
    output += bucket.tokens.outputTokens;
    cacheSavingsUsd += bucket.cacheSavingsUsd;
    records += bucket.records;
    unpricedRecords += bucket.unpricedRecords;

    const provider = providerTotals.get(bucket.provider) ?? {
      costUsd: 0,
      tokens: 0,
    };
    provider.costUsd += bucket.costUsd;
    provider.tokens += totalTokens(bucket.tokens);
    providerTotals.set(bucket.provider, provider);

    const modelKey = `${bucket.provider} ${bucket.model}`;
    const model = modelTotals.get(modelKey) ?? {
      provider: bucket.provider,
      model: bucket.model,
      costUsd: 0,
      tokens: 0,
      records: 0,
      unpricedRecords: 0,
    };
    model.costUsd += bucket.costUsd;
    model.tokens += totalTokens(bucket.tokens);
    model.records += bucket.records;
    model.unpricedRecords += bucket.unpricedRecords;
    modelTotals.set(modelKey, model);

    const period = periodIndex.get(bucket.hourStart ?? bucket.day);
    if (period) period.byProvider[bucket.provider] += bucketValue(bucket);
  }

  return {
    costUsd,
    tokens: uncachedInput + cachedInput + cacheCreation + output,
    cachedInput,
    uncachedInput: uncachedInput + cacheCreation,
    output,
    cacheSavingsUsd,
    records,
    unpricedRecords,
    providers: PROVIDERS.map((preset) => ({
      ...preset,
      costUsd: providerTotals.get(preset.key)?.costUsd ?? 0,
      tokens: providerTotals.get(preset.key)?.tokens ?? 0,
    })).filter((provider) => provider.tokens > 0),
    models: [...modelTotals.values()]
      .map((model) => ({
        provider: model.provider,
        model: model.model,
        costUsd: model.costUsd,
        tokens: model.tokens,
        unpriced: model.unpricedRecords === model.records,
      }))
      .sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens),
    periods,
  };
}

/** 1/2/5 x 10^n step, rounded UP past the peak so no bar clips. */
function niceScale(peak: number): { max: number; ticks: number[] } {
  if (peak <= 0) return { max: 1, ticks: [0, 0.5, 1] };
  const rough = peak / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const step =
    (residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1) * magnitude;
  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let tick = 0; tick <= max + step / 2; tick += step) ticks.push(tick);
  return { max, ticks };
}

const CHART_HEIGHT = 180;
const SEGMENT_GAP = 2;

function UsageChart({
  periods,
  metric,
}: {
  periods: PeriodPoint[];
  metric: "cost" | "tokens";
}) {
  const [hover, setHover] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const peak = Math.max(
    0,
    ...periods.map((period) =>
      PROVIDERS.reduce((sum, p) => sum + period.byProvider[p.key], 0),
    ),
  );
  const scale = niceScale(peak);
  const formatValue = metric === "cost" ? formatUsd : formatTokens;
  const count = periods.length;

  const onMouseMove = useCallback(
    (event: React.MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || count === 0) return;
      const index = Math.min(
        count - 1,
        Math.max(
          0,
          Math.floor(((event.clientX - rect.left) / rect.width) * count),
        ),
      );
      setHover(index);
    },
    [count],
  );

  const hovered = hover !== null ? periods[hover] : undefined;
  const hoveredTotal = hovered
    ? PROVIDERS.reduce((sum, p) => sum + hovered.byProvider[p.key], 0)
    : 0;

  return (
    <div className="relative flex gap-2" data-testid="usage-chart">
      {/* Y labels live outside the svg so they stay crisp at any width. */}
      <div
        className="flex w-12 shrink-0 flex-col-reverse justify-between text-right font-mono text-[10px] text-fg-faint"
        style={{ height: CHART_HEIGHT }}
      >
        {scale.ticks.map((tick) => (
          <span key={tick}>{formatValue(tick)}</span>
        ))}
      </div>
      <div
        ref={containerRef}
        className="relative min-w-0 flex-1"
        onMouseMove={onMouseMove}
        onMouseLeave={() => setHover(null)}
      >
        <svg
          width="100%"
          height={CHART_HEIGHT}
          role="img"
          aria-label="Usage per period by provider"
        >
          {scale.ticks.map((tick) => {
            const y = CHART_HEIGHT - (tick / scale.max) * CHART_HEIGHT;
            return (
              <line
                key={tick}
                x1="0"
                x2="100%"
                y1={y}
                y2={y}
                stroke="var(--color-border)"
                strokeWidth="1"
              />
            );
          })}
          {periods.map((period, index) => {
            const slot = 100 / count;
            const barWidth = Math.max(30, 100 - count * 1.2);
            const x = `${index * slot + (slot * (100 - barWidth)) / 200}%`;
            const width = `${(slot * barWidth) / 100}%`;
            let yCursor = CHART_HEIGHT;
            const segments = PROVIDERS.flatMap((provider) => {
              const value = period.byProvider[provider.key];
              if (value <= 0) return [];
              const height = Math.max(
                1,
                (value / scale.max) * CHART_HEIGHT - SEGMENT_GAP,
              );
              yCursor -= height + SEGMENT_GAP;
              return [
                {
                  provider,
                  y: yCursor + SEGMENT_GAP,
                  height,
                },
              ];
            });
            return (
              <g
                key={period.key}
                opacity={hover === null || hover === index ? 1 : 0.55}
              >
                {segments.map((segment, segmentIndex) => (
                  <rect
                    key={segment.provider.key}
                    x={x}
                    y={segment.y}
                    width={width}
                    height={segment.height}
                    rx={segmentIndex === segments.length - 1 ? 2 : 0}
                    fill={segment.provider.colorVar}
                  />
                ))}
              </g>
            );
          })}
        </svg>
        {hovered && hoveredTotal > 0 && (
          <div
            className="pointer-events-none absolute top-0 z-10 rounded-md border border-border bg-bg-overlay px-2.5 py-1.5 text-[11px] shadow-lg"
            style={{
              left: `${Math.min(80, ((hover ?? 0) / count) * 100)}%`,
            }}
          >
            <div className="mb-1 font-medium text-fg">{hovered.label}</div>
            {PROVIDERS.filter((p) => hovered.byProvider[p.key] > 0).map((p) => (
              <div key={p.key} className="flex items-center gap-1.5">
                <span
                  className="size-2 rounded-full"
                  style={{ background: p.colorVar }}
                />
                <span className="text-fg-muted">{p.label}</span>
                <span className="ml-auto pl-3 font-mono text-fg">
                  {formatValue(hovered.byProvider[p.key])}
                </span>
              </div>
            ))}
            <div className="mt-1 flex items-center gap-1.5 border-t border-border pt-1">
              <span className="text-fg-muted">Total</span>
              <span className="ml-auto pl-3 font-mono text-fg">
                {formatValue(hoveredTotal)}
              </span>
            </div>
          </div>
        )}
        {/* X labels: first, middle, last. */}
        <div className="mt-1 flex justify-between font-mono text-[10px] text-fg-faint">
          <span>{periods[0]?.label}</span>
          <span>{periods[Math.floor(count / 2)]?.label}</span>
          <span>{periods[count - 1]?.label}</span>
        </div>
      </div>
    </div>
  );
}

export function UsageScreen() {
  const [days, setDays] = useState<1 | 7 | 30 | 90>(30);
  const [metric, setMetric] = useState<"cost" | "tokens">("cost");
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((window: 1 | 7 | 30 | 90) => {
    setLoading(true);
    setError(null);
    desktopApi
      .usageSummary(window)
      .then((result) => setSummary(result))
      .catch(() => setError("The transcript scan failed. Try refreshing."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(days);
  }, [days, load]);

  const rollup = useMemo(
    () => (summary ? rollUp(summary, metric) : null),
    [summary, metric],
  );
  const formatValue = metric === "cost" ? formatUsd : formatTokens;
  const empty = rollup !== null && rollup.records === 0;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-bg"
      data-testid="usage-screen"
    >
      <div className="mx-auto w-full max-w-3xl px-6 py-6">
        <div className="mb-5 flex items-center gap-3">
          <h1 className="text-sm font-semibold text-fg">Usage</h1>
          <div className="ml-auto flex items-center gap-2">
            <Segmented
              value={metric}
              options={[
                { value: "cost", label: "Cost" },
                { value: "tokens", label: "Tokens" },
              ]}
              onChange={(value) => setMetric(value as "cost" | "tokens")}
              testId="usage-metric"
            />
            <Segmented
              value={String(days)}
              options={RANGE_OPTIONS}
              onChange={(value) => setDays(Number(value) as 1 | 7 | 30 | 90)}
              testId="usage-range"
            />
            <button
              type="button"
              title="Rescan transcripts"
              className="grid size-6 cursor-pointer place-items-center rounded-md text-fg-faint transition-colors duration-100 hover:bg-bg-overlay hover:text-fg-muted"
              onClick={() => load(days)}
            >
              <RefreshCw className="size-3.5" />
            </button>
          </div>
        </div>

        <p className="mb-5 text-xs text-fg-faint">
          Every Claude Code and Codex session on this machine, terminal use
          included. Cost is an API price estimate; subscription billing is
          separate.
        </p>

        {error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : loading && !summary ? (
          <p className="animate-pulse text-sm text-fg-muted">
            Scanning transcripts…
          </p>
        ) : rollup && summary ? (
          <>
            <div className="mb-6 flex items-end gap-6">
              <div>
                <div
                  className="font-mono text-3xl font-semibold text-fg"
                  data-testid="usage-headline"
                >
                  {metric === "cost"
                    ? formatUsd(rollup.costUsd)
                    : formatTokens(rollup.tokens)}
                </div>
                <div className="mt-1 text-xs text-fg-faint">
                  {rollup.records === 0
                    ? "No activity in this window."
                    : `${summary.sessions} sessions · ${
                        metric === "cost" ? "API estimate" : "processed tokens"
                      }`}
                </div>
              </div>
              <div className="ml-auto flex flex-col items-end gap-1.5">
                {rollup.providers.map((provider) => (
                  <div
                    key={provider.key}
                    className="flex items-center gap-2 text-xs"
                  >
                    <span
                      className="size-2 rounded-full"
                      style={{ background: provider.colorVar }}
                    />
                    <span className="text-fg-muted">{provider.label}</span>
                    <span className="font-mono text-fg">
                      {metric === "cost"
                        ? formatUsd(provider.costUsd)
                        : formatTokens(provider.tokens)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {!empty && <UsageChart periods={rollup.periods} metric={metric} />}

            {!empty && (
              <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-5">
                {[
                  { label: "Processed", value: formatTokens(rollup.tokens) },
                  {
                    label: "Cached input",
                    value: formatTokens(rollup.cachedInput),
                  },
                  {
                    label: "Uncached input",
                    value: formatTokens(rollup.uncachedInput),
                  },
                  { label: "Output", value: formatTokens(rollup.output) },
                  {
                    label: "Cache savings",
                    value: formatUsd(rollup.cacheSavingsUsd),
                  },
                ].map((stat) => (
                  <div key={stat.label} className="bg-bg-raised px-3 py-2.5">
                    <div className="font-mono text-sm text-fg">
                      {stat.value}
                    </div>
                    <div className="mt-0.5 text-[10px] uppercase tracking-wide text-fg-faint">
                      {stat.label}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {!empty && (
              <table className="mt-6 w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-fg-faint">
                    <th className="py-1.5 font-medium">Model</th>
                    <th className="py-1.5 text-right font-medium">Tokens</th>
                    <th className="py-1.5 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {rollup.models.map((model) => {
                    const preset = PROVIDERS.find(
                      (p) => p.key === model.provider,
                    );
                    return (
                      <tr
                        key={`${model.provider} ${model.model}`}
                        className="border-b border-border/50"
                      >
                        <td className="flex items-center gap-2 py-1.5 text-fg">
                          <span
                            className="size-2 shrink-0 rounded-full"
                            style={{ background: preset?.colorVar }}
                          />
                          {model.model}
                        </td>
                        <td className="py-1.5 text-right font-mono text-fg-muted">
                          {formatTokens(model.tokens)}
                        </td>
                        <td className="py-1.5 text-right font-mono text-fg-muted">
                          {model.unpriced
                            ? "Not priced"
                            : formatUsd(model.costUsd)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            <p className="mt-4 text-[10px] text-fg-faint">
              {summary.pricing.status === "none"
                ? "Model prices unavailable; tokens are still counted."
                : summary.pricing.status === "cached"
                  ? "Using cached model prices."
                  : "Model prices are current."}
              {rollup.unpricedRecords > 0 &&
                ` ${rollup.unpricedRecords} of ${rollup.records} responses have no known price and count as $0.`}
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}
