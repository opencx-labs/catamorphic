/** Semantic app icons. Hosts map this vocabulary to their own icon library. */
export const APP_ICON_NAMES = [
  "default",
  "review",
  "dashboard",
  "report",
  "tracker",
  "form",
  "calculator",
] as const;

export type AppIconName = (typeof APP_ICON_NAMES)[number];

export const APP_ICON_DESCRIPTIONS: Record<AppIconName, string> = {
  default: "General app, prototype, or anything without a clear match",
  review: "Code reviews and pull request walkthroughs",
  dashboard: "Metrics and monitoring dashboards",
  report: "Reports and analytical summaries",
  tracker: "Task, issue, and progress trackers",
  form: "Forms, questionnaires, and data collection",
  calculator: "Calculators and numerical what-if tools",
};

/** Unknown or omitted metadata must retain the ordinary app icon. */
export function resolveAppIcon(value: unknown): AppIconName {
  return APP_ICON_NAMES.find((name) => name === value) ?? "default";
}
