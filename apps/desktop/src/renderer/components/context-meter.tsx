/**
 * The composer's context ring (ADR 0057): how full the session's context
 * window is, read from the last settled turn's usage. Renders nothing
 * until a harness has reported both occupancy and window size (Claude
 * Code does; Codex's stream reports neither). Danger red past 90%, quiet
 * otherwise.
 */
import type { TimelineTurn } from "@catamorphic/react";
import { formatTokenCount } from "../../shared/usage.js";
import { ShortcutHint } from "./shortcut-hint.js";

interface ContextSnapshot {
  usedTokens: number;
  windowTokens: number;
}

export function latestContextSnapshot(
  turns: readonly TimelineTurn[],
): ContextSnapshot | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const usage = turns[index]?.turn?.outcome?.usage;
    const used = usage?.contextTokens;
    const window = usage?.contextWindow;
    if (
      typeof used === "number" &&
      typeof window === "number" &&
      used > 0 &&
      window > 0
    ) {
      return { usedTokens: used, windowTokens: window };
    }
  }
  return null;
}

/** Notices after which earlier replies belong to a different model. */
const SELECTION_CHANGES = new Set(["agent_changed", "model_changed"]);

/** Last model id a harness reported as actually serving this conversation. */
export function latestReportedModel(
  turns: readonly TimelineTurn[],
): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const group = turns[index];
    if (!group) continue;
    // Replies preceding a selection change belong to a different model.
    if (
      group.entries.some(
        (entry) =>
          entry.kind === "notice" && SELECTION_CHANGES.has(entry.item.code),
      )
    )
      return null;
    const model = group.turn?.outcome?.usage?.model;
    if (typeof model === "string" && model.length > 0) return model;
  }
  return null;
}

export function ContextMeter({ turns }: { turns: readonly TimelineTurn[] }) {
  const snapshot = latestContextSnapshot(turns);
  if (!snapshot) return null;
  const fraction = Math.min(1, snapshot.usedTokens / snapshot.windowTokens);
  const percent = Math.round(fraction * 100);
  const overloaded = fraction > 0.9;
  const radius = 5.5;
  const circumference = 2 * Math.PI * radius;
  return (
    <ShortcutHint
      label={`Context ${percent}% full · ${formatTokenCount(snapshot.usedTokens)} of ${formatTokenCount(snapshot.windowTokens)} tokens`}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: the custom SVG meter carries the complete meter semantics on its wrapper */}
      <div
        className="grid size-8 shrink-0 place-items-center"
        role="meter"
        aria-label="Context window"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        data-testid="context-meter"
        data-percent={percent}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          className="-rotate-90"
          aria-hidden="true"
        >
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            stroke="var(--color-border-strong)"
            strokeWidth="2"
          />
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            stroke={
              overloaded ? "var(--color-danger)" : "var(--color-fg-faint)"
            }
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - fraction)}
          />
        </svg>
      </div>
    </ShortcutHint>
  );
}
