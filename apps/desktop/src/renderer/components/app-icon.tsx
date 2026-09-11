import { type AppIconName, resolveAppIcon } from "@catamorphic/app";
import {
  Calculator,
  ClipboardList,
  FileChartColumn,
  GitPullRequest,
  LayoutDashboard,
  LayoutGrid,
  ListChecks,
  type LucideIcon,
} from "lucide-react";

/** One monochrome glyph per app type, shared by every desktop surface. */
const APP_GLYPHS: Record<AppIconName, LucideIcon> = {
  default: LayoutGrid,
  review: GitPullRequest,
  dashboard: LayoutDashboard,
  report: FileChartColumn,
  tracker: ListChecks,
  form: ClipboardList,
  calculator: Calculator,
};

export function appGlyph(icon: unknown): LucideIcon {
  return APP_GLYPHS[resolveAppIcon(icon)];
}

export function AppGlyph({
  icon,
  className,
}: {
  icon?: string | null;
  className?: string;
}) {
  const Icon = appGlyph(icon);
  return (
    <Icon
      className={className}
      data-app-icon={resolveAppIcon(icon)}
      aria-hidden="true"
    />
  );
}
