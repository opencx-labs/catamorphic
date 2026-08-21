/**
 * The composer's context ring (ADR 0057): how full the session's context
 * window is, read from the last settled reply's metadata.usage. Renders
 * nothing until a harness has reported both occupancy and window size
 * (Claude Code does; Codex's stream reports neither). Danger red past
 * 90%, quiet otherwise.
 */
import { ShortcutHint } from "./shortcut-hint.js";

interface MessageLike {
  role: string;
  metadata?: Record<string, unknown> | null;
}

interface ContextSnapshot {
  usedTokens: number;
  windowTokens: number;
}

export function latestContextSnapshot(
  messages: MessageLike[],
): ContextSnapshot | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    const usage = message.metadata?.usage as
      | { contextTokens?: unknown; contextWindow?: unknown }
      | undefined;
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

function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${Math.round(value / 1000)}K`;
  return `${Number((value / 1_000_000).toPrecision(3))}M`;
}

export function ContextMeter({ messages }: { messages: MessageLike[] }) {
  const snapshot = latestContextSnapshot(messages);
  if (!snapshot) return null;
  const fraction = Math.min(1, snapshot.usedTokens / snapshot.windowTokens);
  const percent = Math.round(fraction * 100);
  const overloaded = fraction > 0.9;
  const radius = 5.5;
  const circumference = 2 * Math.PI * radius;
  return (
    <ShortcutHint
      label={`Context ${percent}% full · ${formatTokens(snapshot.usedTokens)} of ${formatTokens(snapshot.windowTokens)} tokens`}
    >
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
        <svg width="16" height="16" viewBox="0 0 16 16" className="-rotate-90">
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
            stroke={overloaded ? "var(--color-danger)" : "var(--color-fg-faint)"}
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
