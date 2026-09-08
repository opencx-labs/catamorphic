import { Bot } from "lucide-react";
import claude from "../assets/harnesses/claude.svg";
import openai from "../assets/harnesses/openai.svg";
import openrouter from "../assets/harnesses/openrouter.svg";

/** Native harness brands; the built-in AI SDK keeps the generic agent mark. */
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
    harness === "codex"
      ? "openai"
      : harness === "claude-code"
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
