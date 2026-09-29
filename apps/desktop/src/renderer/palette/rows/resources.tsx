import { Globe, Workflow as WorkflowIcon } from "lucide-react";
import { useMemo } from "react";
import { webUsageKey } from "../../../shared/palette.js";
import type { SidebarItem } from "../../../shared/sidebar.js";
import {
  sidebarSections,
  type WorkspaceSourceName,
} from "../../../shared/workspace-config.js";
import { SiteFavicon } from "../../components/site-favicon.js";
import { lucideIcon } from "../../lib/lucide-icon.js";
import { NEW_WORKFLOW_PROMPT } from "../../lib/workflow-authoring.js";
import { usePaletteHost } from "../host.js";
import { useSourceRows } from "../sources.js";
import type { PaletteItem } from "../types.js";
import { bareUrl, hostOf } from "../urls.js";

/** The workspace sources the unscoped palette lists (ADR 0186). */
const RESOURCE_SOURCES: readonly WorkspaceSourceName[] = [
  "workflows",
  "apps",
  "chats",
  "bookmarks",
];

/**
 * Project resources the palette opens: workflows, apps, chats and
 * bookmarks from the workspace sources the sidebar reads, plus custom
 * sidebar links. Each ranks by its history counts.
 */
export function useResourceRows({ active }: { active: boolean }) {
  const {
    projectId,
    workspaceConfig,
    onOpenUrl,
    onSendToAgent,
    onError,
    canCreateWorkflows = false,
  } = usePaletteHost();
  const sourceRows = useSourceRows({
    names: RESOURCE_SOURCES,
    active,
    projectId,
    onError: (message) => onError?.(message),
  });
  const resourceItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];
    if (canCreateWorkflows)
      items.push({
        id: "create-workflow",
        icon: WorkflowIcon,
        label: "Create workflow",
        detail: "Describe it to your agent",
        keywords: ["new", "workflow", "automation", "build"],
        kind: "action",
        category: "command",
        usage: "create-workflow",
        run: (mode) =>
          onSendToAgent(NEW_WORKFLOW_PROMPT, mode === "tab" ? "tab" : "float"),
      });
    items.push(...sourceRows);
    // Static links in custom sections have no source: they are the config.
    const addCustomItems = (customItems: SidebarItem[] | undefined) => {
      for (const item of customItems ?? []) {
        if (item.url) {
          const url = item.url;
          items.push({
            id: `custom:${item.label}:${url}`,
            icon: lucideIcon(item.icon) ?? Globe,
            iconNode: item.icon ? undefined : (
              <SiteFavicon url={url} className="size-4" />
            ),
            label: item.label,
            detail: hostOf(url),
            keywords: [
              item.label,
              hostOf(url),
              bareUrl(url),
              "link",
              ...(item.keywords ?? []),
            ],
            kind: "navigate",
            category: "bookmark",
            usage: webUsageKey(url),
            run: (mode) => onOpenUrl(url, mode),
          });
        }
        addCustomItems(item.items);
      }
    };
    for (const section of sidebarSections(workspaceConfig)) {
      if (section.type !== "custom" || section.source) continue;
      addCustomItems(section.items);
    }
    return items;
  }, [
    canCreateWorkflows,
    onSendToAgent,
    sourceRows,
    workspaceConfig,
    onOpenUrl,
  ]);
  // Bookmarked pages carry a star wherever they appear, history included.
  const bookmarkedUsage = useMemo(
    () =>
      new Set(
        sourceRows.flatMap((row) =>
          row.bookmarked && row.usage ? [row.usage] : [],
        ),
      ),
    [sourceRows],
  );
  return { resourceItems, bookmarkedUsage };
}
