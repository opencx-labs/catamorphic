import path from "node:path";
import { app } from "electron";
import { type ManifestCommand, manifestCommands } from "./commands.js";
import { extensionFile, fileDataUrl } from "./icons.js";
import {
  bestIcon,
  contentScriptMatches,
  localizer,
  type Manifest,
  type ManifestAction,
  manifestAction,
  manifestIcons,
  optionalPermissions,
  type PermissionSet,
  permissionWarnings,
  readManifest,
  requiredPermissions,
  sidePanelPath,
} from "./manifest.js";
import type { InstalledExtension } from "./registry.js";
import { matchesAny, patternCovers } from "./url-policy.js";

/**
 * An installed extension as the host uses it while it runs (ADR 0203): its
 * manifest read once, localized, with the permissions it holds.
 */
export class LoadedExtension {
  readonly root: string;
  readonly manifest: Manifest;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly required: PermissionSet;
  readonly optional: PermissionSet;
  readonly action: ManifestAction | null;
  readonly commands: ManifestCommand[];
  readonly sidePanelPath: string | null;
  readonly localize: (text: string) => string;
  /** Tabs where the person invoked the extension (`activeTab`). */
  readonly activeTabs = new Set<number>();
  /** `sidePanel.setPanelBehavior`. */
  openPanelOnActionClick = false;
  /** `sidePanel.setOptions`, global (-1) and per tab. */
  readonly panelOptions = new Map<
    number,
    { path?: string; enabled?: boolean }
  >();
  granted: PermissionSet;

  constructor(
    readonly profileId: string,
    readonly record: InstalledExtension,
  ) {
    this.root = record.path;
    this.manifest = readManifest(record.path);
    this.localize = localizer(record.path, this.manifest, app.getLocale());
    this.name = this.localize(String(this.manifest.name ?? record.id));
    this.description = this.localize(
      typeof this.manifest.description === "string"
        ? this.manifest.description
        : "",
    );
    this.version = String(this.manifest.version ?? record.version);
    this.required = requiredPermissions(this.manifest);
    this.optional = optionalPermissions(this.manifest);
    this.granted = record.granted;
    this.action = manifestAction(this.manifest);
    this.commands = manifestCommands(
      this.manifest,
      process.platform,
      this.localize,
    );
    this.sidePanelPath = sidePanelPath(this.manifest);
  }

  get id(): string {
    return this.record.id;
  }

  get manifestVersion(): 2 | 3 {
    return this.manifest.manifest_version === 2 ? 2 : 3;
  }

  /** An API permission it holds (declared, or optional and granted). */
  has(permission: string): boolean {
    return (
      this.required.permissions.includes(permission) ||
      this.granted.permissions.includes(permission)
    );
  }

  /** Host patterns it holds; content script sites are not host access. */
  hostPatterns(): string[] {
    return [...this.required.origins, ...this.granted.origins];
  }

  /** May it see this tab's address and title? */
  seesTab(tabId: number, url: string): boolean {
    return (
      this.has("tabs") ||
      this.activeTabs.has(tabId) ||
      matchesAny(this.hostPatterns(), url)
    );
  }

  /** Is the origin pattern covered by what it holds? */
  holdsOrigin(pattern: string): boolean {
    return this.hostPatterns().some((granted) =>
      patternCovers(granted, pattern),
    );
  }

  warnings(): string[] {
    return permissionWarnings(this.manifest, {
      permissions: [...this.required.permissions, ...this.granted.permissions],
      origins: [...this.required.origins, ...this.granted.origins],
    });
  }

  /** A data URL of its icon near `size` pixels. */
  icon(size: number): string | null {
    const action = this.action?.icon;
    const file =
      bestIcon(manifestIcons(this.manifest), size) ?? bestIcon(action, size);
    return file ? fileDataUrl(extensionFile(this.root, this.id, file)) : null;
  }

  /** Its toolbar icon near `size` pixels: the action's, else its own. */
  actionIcon(size: number): string | null {
    const file =
      bestIcon(this.action?.icon, size) ??
      bestIcon(manifestIcons(this.manifest), size);
    return file ? fileDataUrl(extensionFile(this.root, this.id, file)) : null;
  }

  url(relative: string): string {
    return new URL(
      relative.replace(/^\/+/, ""),
      `chrome-extension://${this.id}/`,
    ).href;
  }

  optionsUrl(): string | null {
    const page =
      (this.manifest.options_ui as { page?: unknown } | undefined)?.page ??
      this.manifest.options_page;
    return typeof page === "string" && page ? this.url(page) : null;
  }

  /** The side panel page for a tab, honoring per-tab and global options. */
  panelFor(tabId: number | null): { path: string | null; enabled: boolean } {
    const global = this.panelOptions.get(-1) ?? {};
    const tab = tabId === null ? {} : (this.panelOptions.get(tabId) ?? {});
    return {
      path: tab.path ?? global.path ?? this.sidePanelPath,
      enabled: tab.enabled ?? global.enabled ?? true,
    };
  }

  contentScriptMatches(): string[] {
    return contentScriptMatches(this.manifest);
  }

  /** Its folder name for logs, never a path. */
  get folder(): string {
    return path.basename(this.root);
  }
}
