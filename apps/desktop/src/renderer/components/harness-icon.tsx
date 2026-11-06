import { Bot } from "lucide-react";
import claude from "../assets/harnesses/claude.svg";
import openai from "../assets/harnesses/openai.svg";
import openrouter from "../assets/harnesses/openrouter.svg";

/** Recognized harness/provider brands; unknown backends keep the agent mark. */
export function HarnessIcon({
  harness,
  provider,
  className = "size-3.5",
}: {
  harness?: string;
  provider?: string;
  className?: string;
}) {
  const brand =
    harness === "codex" || provider === "openai"
      ? "openai"
      : harness === "claude-code" || provider === "anthropic"
        ? "claude"
        : provider === "openrouter"
          ? "openrouter"
          : "default";
  if (brand === "default")
    return (
      <Bot
        aria-hidden="true"
        data-harness-icon={brand}
        className={`shrink-0 ${className}`}
      />
    );
  const source = { openai, claude, openrouter }[brand];
  return (
    <span
      aria-hidden="true"
      data-harness-icon={brand}
      className={`inline-block shrink-0 bg-current ${className}`}
      style={{
        maskImage: `url("${source}")`,
        maskSize: "contain",
        maskPosition: "center",
        maskRepeat: "no-repeat",
      }}
    />
  );
}

/** The tool an imported chat came from, as people name it (ADR 0233). */
export function importedHarnessLabel(harness: "claude-code" | "codex"): string {
  return harness === "codex" ? "Codex" : "Claude Code";
}
