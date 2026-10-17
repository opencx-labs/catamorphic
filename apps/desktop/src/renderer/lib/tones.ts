import type { SidebarTone } from "../../shared/sidebar.js";

/**
 * A row's or chip's tone as the theme's text color (ADR 0238): the same
 * five semantic tokens wherever a source's rows are drawn.
 */
export const TONE_TEXT: Record<SidebarTone, string> = {
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
};
