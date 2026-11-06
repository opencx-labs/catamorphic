import type { ConnectorSearchData } from "./desktop-api";

/**
 * How Connectors reads the plugin catalog: names a person can say, the
 * marketplaces' own categories in a useful order, and search ranked by
 * name before description. Pure, so the dialog only lays things out.
 */
export type PluginEntry = ConnectorSearchData["plugins"][number];
export type ServerEntry = ConnectorSearchData["registry"][number];

/** Words a slug spells in lowercase that their owners never do. */
const SPELLINGS: Record<string, string> = {
  ai: "AI",
  api: "API",
  aws: "AWS",
  cli: "CLI",
  crm: "CRM",
  csharp: "C#",
  css: "CSS",
  db: "DB",
  gcp: "GCP",
  github: "GitHub",
  gitlab: "GitLab",
  graphql: "GraphQL",
  hubspot: "HubSpot",
  ios: "iOS",
  javascript: "JavaScript",
  lsp: "LSP",
  macos: "macOS",
  md: "MD",
  mcp: "MCP",
  mongodb: "MongoDB",
  openai: "OpenAI",
  php: "PHP",
  postgresql: "PostgreSQL",
  pr: "PR",
  qa: "QA",
  sap: "SAP",
  sdk: "SDK",
  seo: "SEO",
  sql: "SQL",
  typescript: "TypeScript",
  ui: "UI",
  ux: "UX",
};

/** A plugin's name: the catalog's display name, else its slug in words. */
export function pluginTitle(entry: {
  name: string;
  displayName?: string;
}): string {
  const display = entry.displayName?.trim();
  if (display) return display;
  return entry.name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(
      (word) =>
        SPELLINGS[word.toLowerCase()] ??
        `${word.charAt(0).toUpperCase()}${word.slice(1)}`,
    )
    .join(" ");
}

/** Categories most people look for first; the rest follow alphabetically. */
const CATEGORY_ORDER = [
  "productivity",
  "development",
  "database",
  "design",
  "monitoring",
  "security",
  "deployment",
  "finance",
  "automation",
  "testing",
  "learning",
];

const CATEGORY_LABELS: Record<string, string> = { database: "Data" };

/** Entries without a category gather here, last. */
export const OTHER_CATEGORY = "other";

export function categoryLabel(category: string): string {
  if (category === OTHER_CATEGORY) return "More plugins";
  return (
    CATEGORY_LABELS[category] ??
    `${category.charAt(0).toUpperCase()}${category.slice(1)}`
  );
}

export function categoryOf(entry: PluginEntry): string {
  return entry.category ?? OTHER_CATEGORY;
}

export interface CategoryGroup {
  category: string;
  label: string;
  entries: PluginEntry[];
}

/**
 * The catalog by category, in a stable order. Within a category, entries
 * a vendor names and signs come first (they read as products, and usually
 * carry an icon); otherwise the marketplace's own order stands.
 */
export function groupByCategory(entries: PluginEntry[]): CategoryGroup[] {
  const groups = new Map<string, PluginEntry[]>();
  for (const entry of entries) {
    const category = categoryOf(entry);
    groups.set(category, [...(groups.get(category) ?? []), entry]);
  }
  const rank = (category: string) => {
    if (category === OTHER_CATEGORY) return Number.MAX_SAFE_INTEGER;
    const index = CATEGORY_ORDER.indexOf(category);
    return index === -1 ? CATEGORY_ORDER.length : index;
  };
  const presence = (entry: PluginEntry) =>
    (entry.displayName ? 2 : 0) + (entry.author ? 1 : 0);
  return [...groups.entries()]
    .sort(
      ([a], [b]) =>
        rank(a) - rank(b) || categoryLabel(a).localeCompare(categoryLabel(b)),
    )
    .map(([category, list]) => ({
      category,
      label: categoryLabel(category),
      entries: list
        .map((entry, index) => ({ entry, index }))
        .sort(
          (a, b) => presence(b.entry) - presence(a.entry) || a.index - b.index,
        )
        .map(({ entry }) => entry),
    }));
}

/**
 * The catalog narrowed to a query, best match first: a name that starts
 * with it, then a name containing it, then a publisher or category, then
 * a description. Empty queries keep every entry in order.
 */
export function searchCatalog(
  entries: PluginEntry[],
  query: string,
): PluginEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  const score = (entry: PluginEntry): number => {
    const names = [pluginTitle(entry), entry.name].map((name) =>
      name.toLowerCase(),
    );
    if (names.some((name) => name.startsWith(needle))) return 0;
    if (names.some((name) => name.includes(needle))) return 1;
    if (
      [entry.author, entry.category && categoryLabel(entry.category)].some(
        (field) => field?.toLowerCase().includes(needle),
      )
    )
      return 2;
    if (entry.description.toLowerCase().includes(needle)) return 3;
    return -1;
  };
  return entries
    .map((entry, index) => ({ entry, index, score: score(entry) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(({ entry }) => entry);
}

/**
 * A page whose favicon stands for the vendor: hosting sites (a GitHub
 * repository) would give every such entry the same mark, so they give none.
 */
export function brandPage(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol !== "https:") return undefined;
    return /(^|\.)(github\.com|githubusercontent\.com|gitlab\.com)$/.test(
      hostname,
    )
      ? undefined
      : url;
  } catch {
    return undefined;
  }
}

const MARKETPLACE_LABELS: Record<string, string> = {
  "anthropics/claude-plugins-official": "Claude Plugins",
  "anthropics/knowledge-work-plugins": "Knowledge Work Plugins",
};

/** A marketplace by name: the default ones by title, others as added. */
export function marketplaceLabel(ref: string): string {
  return MARKETPLACE_LABELS[ref] ?? ref;
}

/**
 * Names a list holds more than once (two marketplaces each carrying a
 * "Slack"). The list shows those rows with their source.
 */
export function repeatedNames(names: string[]): Set<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) repeated.add(name);
    seen.add(name);
  }
  return repeated;
}

/**
 * Who publishes a registry server, read from its reverse-domain
 * namespace: `com.pulsemcp/slack` is pulsemcp.com's.
 */
export function registryPublisher(name: string): string {
  const slash = name.indexOf("/");
  if (slash <= 0) return name;
  return name.slice(0, slash).split(".").reverse().join(".");
}

/** Stable key for a plugin across the catalog and the installed list. */
export function pluginKey(entry: {
  marketplace: string;
  name: string;
}): string {
  return `${entry.marketplace}#${entry.name}`;
}
