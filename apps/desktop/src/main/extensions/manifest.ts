import fs from "node:fs";
import path from "node:path";
import { safeEntryPath } from "./archive.js";

/**
 * Reading an extension's manifest the way the host needs it (ADR 0203):
 * its localized name and description, the permissions it asks for and the
 * warnings Chrome would show for them, its toolbar action, options page,
 * side panel and default request-blocking rulesets.
 */

export type Manifest = Record<string, unknown> & {
  manifest_version?: number;
  name?: string;
  version?: string;
};

export class ManifestError extends Error {
  override name = "ManifestError";
}

/** Chrome reads manifests with comments; strip them outside strings. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index++;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index++;
      out += "\n";
    } else if (char === "/" && next === "*") {
      index += 2;
      while (
        index < text.length &&
        !(text[index] === "*" && text[index + 1] === "/")
      )
        index++;
      index++;
    } else out += char;
  }
  return out;
}

export function parseManifest(text: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text.replace(/^﻿/, "")));
  } catch (cause) {
    throw new ManifestError(
      `manifest.json is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new ManifestError("manifest.json is not an object");
  const manifest = parsed as Manifest;
  if (manifest.manifest_version !== 2 && manifest.manifest_version !== 3)
    throw new ManifestError("Unsupported manifest_version");
  if (typeof manifest.name !== "string" || !manifest.name.trim())
    throw new ManifestError("The manifest has no name");
  if (
    typeof manifest.version !== "string" ||
    !/^\d{1,9}(\.\d{1,9}){0,3}$/.test(manifest.version)
  )
    throw new ManifestError("The manifest has no valid version");
  return manifest;
}

export function readManifest(dir: string): Manifest {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, "manifest.json"), "utf-8");
  } catch {
    throw new ManifestError("The folder has no manifest.json");
  }
  return parseManifest(text);
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const asStrings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

type Messages = Record<string, { message?: unknown }>;

function readMessages(dir: string, locale: string): Messages | null {
  const relative = safeEntryPath(`_locales/${locale}/messages.json`);
  if (!relative) return null;
  try {
    const parsed: unknown = JSON.parse(
      stripJsonComments(
        fs.readFileSync(path.join(dir, relative), "utf-8").replace(/^﻿/, ""),
      ),
    );
    const record = asRecord(parsed);
    if (!record) return null;
    const messages: Messages = {};
    for (const [key, value] of Object.entries(record)) {
      const entry = asRecord(value);
      if (entry) messages[key.toLowerCase()] = entry;
    }
    return messages;
  } catch {
    return null;
  }
}

/** Resolve `__MSG_key__` placeholders against the extension's locales. */
export function localizer(
  dir: string,
  manifest: Manifest,
  uiLocale: string,
): (text: string) => string {
  const fallback = asString(manifest.default_locale);
  const candidates = [
    uiLocale.replace("-", "_"),
    uiLocale.split(/[-_]/)[0] ?? "",
    fallback ?? "",
  ].filter((locale, index, all) => locale && all.indexOf(locale) === index);
  const tables = candidates
    .map((locale) => readMessages(dir, locale))
    .filter((table): table is Messages => table !== null);
  return (text) =>
    text.replace(/__MSG_([A-Za-z0-9_@]+)__/g, (whole, key: string) => {
      for (const table of tables) {
        const message = asString(table[key.toLowerCase()]?.message);
        if (message !== undefined) return message;
      }
      return whole;
    });
}

export interface ManifestAction {
  /** The manifest key it came from; MV2 has browser and page actions. */
  key: "action" | "browser_action" | "page_action";
  popup: string | null;
  title: string | null;
  icon: string | Record<string, string> | null;
}

export function manifestAction(manifest: Manifest): ManifestAction | null {
  for (const key of ["action", "browser_action", "page_action"] as const) {
    const action = asRecord(manifest[key]);
    if (!action) continue;
    const icon = action.default_icon;
    const iconRecord = asRecord(icon);
    return {
      key,
      popup: asString(action.default_popup) || null,
      title: asString(action.default_title) || null,
      icon:
        typeof icon === "string"
          ? icon
          : iconRecord
            ? Object.fromEntries(
                Object.entries(iconRecord).filter(
                  (entry): entry is [string, string] =>
                    typeof entry[1] === "string",
                ),
              )
            : null,
    };
  }
  return null;
}

/** The icon file closest to (and preferably not below) `size` pixels. */
export function bestIcon(
  icons: string | Record<string, string> | null | undefined,
  size: number,
): string | null {
  if (!icons) return null;
  if (typeof icons === "string") return icons;
  const sizes = Object.keys(icons)
    .map(Number)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const pick = sizes.find((value) => value >= size) ?? sizes.at(-1);
  return pick === undefined ? null : (icons[String(pick)] ?? null);
}

export function manifestIcons(
  manifest: Manifest,
): Record<string, string> | null {
  const icons = asRecord(manifest.icons);
  if (!icons) return null;
  return Object.fromEntries(
    Object.entries(icons).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export function optionsPage(manifest: Manifest): string | null {
  return (
    asString(asRecord(manifest.options_ui)?.page) ||
    asString(manifest.options_page) ||
    null
  );
}

export function sidePanelPath(manifest: Manifest): string | null {
  return asString(asRecord(manifest.side_panel)?.default_path) || null;
}

/** The static rulesets Chrome enables at install and on every update. */
export function defaultRulesets(manifest: Manifest): string[] {
  const resources = asRecord(manifest.declarative_net_request)?.rule_resources;
  if (!Array.isArray(resources)) return [];
  return resources.flatMap((resource) => {
    const entry = asRecord(resource);
    const id = asString(entry?.id);
    return id && entry?.enabled === true ? [id] : [];
  });
}

export function allRulesets(manifest: Manifest): string[] {
  const resources = asRecord(manifest.declarative_net_request)?.rule_resources;
  if (!Array.isArray(resources)) return [];
  return resources.flatMap((resource) => {
    const id = asString(asRecord(resource)?.id);
    return id ? [id] : [];
  });
}

const HOST_PATTERN = /^(\*|https?|wss?|ftp|file|urn|chrome-extension):\/\//;

function isHostPattern(value: string): boolean {
  return value === "<all_urls>" || HOST_PATTERN.test(value);
}

export interface PermissionSet {
  permissions: string[];
  origins: string[];
}

/** API permissions and host patterns, split the way chrome.permissions is. */
export function requiredPermissions(manifest: Manifest): PermissionSet {
  const declared = asStrings(manifest.permissions);
  const hosts = asStrings(manifest.host_permissions);
  return {
    permissions: declared.filter((value) => !isHostPattern(value)),
    origins: [...hosts, ...declared.filter(isHostPattern)],
  };
}

export function optionalPermissions(manifest: Manifest): PermissionSet {
  const declared = asStrings(manifest.optional_permissions);
  const hosts = asStrings(manifest.optional_host_permissions);
  return {
    permissions: declared.filter((value) => !isHostPattern(value)),
    origins: [...hosts, ...declared.filter(isHostPattern)],
  };
}

export function contentScriptMatches(manifest: Manifest): string[] {
  const scripts = manifest.content_scripts;
  if (!Array.isArray(scripts)) return [];
  return scripts.flatMap((script) => asStrings(asRecord(script)?.matches));
}

const ALL_HOSTS = new Set([
  "<all_urls>",
  "*://*/*",
  "http://*/*",
  "https://*/*",
  "*://*/",
]);

/** Does this pattern reach every site (a scheme wildcard over any host)? */
export function coversAllHosts(pattern: string): boolean {
  if (ALL_HOSTS.has(pattern)) return true;
  const match = /^(\*|https?):\/\/\*\//.exec(pattern);
  return Boolean(match);
}

function patternHost(pattern: string): string | null {
  const match = /^[^:]+:\/\/([^/]+)/.exec(pattern);
  if (!match?.[1]) return null;
  return match[1].replace(/^\*\./, "");
}

/** The search engine an extension wants as the default, if any. */
export interface SearchProvider {
  name: string;
  keyword: string | null;
  searchUrl: string;
  faviconUrl: string | null;
}

export function searchProvider(manifest: Manifest): SearchProvider | null {
  const provider = asRecord(
    asRecord(manifest.chrome_settings_overrides)?.search_provider,
  );
  const searchUrl = asString(provider?.search_url);
  const name = asString(provider?.name);
  if (!provider || !searchUrl || !name) return null;
  try {
    if (new URL(searchUrl.replace("{searchTerms}", "q")).protocol !== "https:")
      return null;
  } catch {
    return null;
  }
  return {
    name,
    keyword: asString(provider.keyword) ?? null,
    searchUrl,
    faviconUrl: asString(provider.favicon_url) ?? null,
  };
}

/**
 * What an extension can do, in Chrome's install-prompt words. Host access
 * comes first; API warnings follow in a stable order. Permissions without a
 * warning in Chrome (storage, alarms, scripting...) add nothing.
 */
export function permissionWarnings(
  manifest: Manifest,
  granted: PermissionSet = requiredPermissions(manifest),
): string[] {
  const permissions = new Set(granted.permissions);
  const hostPatterns = [...granted.origins, ...contentScriptMatches(manifest)];
  const warnings: string[] = [];
  const allHosts =
    hostPatterns.some(coversAllHosts) ||
    permissions.has("debugger") ||
    permissions.has("proxy") ||
    permissions.has("pageCapture");
  if (allHosts) {
    warnings.push("Read and change all your data on all websites");
  } else {
    const hosts = [
      ...new Set(
        hostPatterns
          .map(patternHost)
          .filter((host): host is string => host !== null),
      ),
    ].sort();
    if (hosts.length === 1)
      warnings.push(`Read and change your data on ${hosts[0]}`);
    else if (hosts.length > 1 && hosts.length <= 3)
      warnings.push(
        `Read and change your data on ${hosts.slice(0, -1).join(", ")} and ${hosts.at(-1)}`,
      );
    else if (hosts.length > 3)
      warnings.push(`Read and change your data on ${hosts.length} websites`);
  }
  const has = (...names: string[]) =>
    names.some((name) => permissions.has(name));
  if (has("debugger")) warnings.push("Access the page debugger backend");
  if (has("history")) warnings.push("Read and change your browsing history");
  else if (
    !allHosts &&
    has("tabs", "webNavigation", "declarativeNetRequestFeedback")
  )
    warnings.push("Read your browsing history");
  if (has("sessions") && has("tabs", "history"))
    warnings.push("Read your recently closed tabs");
  if (has("bookmarks")) warnings.push("Read and change your bookmarks");
  if (has("topSites"))
    warnings.push("Read a list of your most frequently visited websites");
  if (has("tabGroups")) warnings.push("View and manage your tab groups");
  if (has("declarativeNetRequest")) warnings.push("Block content on any page");
  if (has("downloads")) warnings.push("Manage your downloads");
  if (has("downloads.open")) warnings.push("Open downloaded files");
  if (has("clipboardRead")) warnings.push("Read data you copy and paste");
  if (has("clipboardWrite")) warnings.push("Modify data you copy and paste");
  if (has("geolocation")) warnings.push("Detect your physical location");
  if (has("notifications")) warnings.push("Display notifications");
  if (has("desktopCapture")) warnings.push("Capture content of your screen");
  if (has("management"))
    warnings.push("Manage your apps, extensions, and themes");
  if (has("privacy")) warnings.push("Change your privacy-related settings");
  if (has("contentSettings"))
    warnings.push(
      "Change settings that control websites' access to features such as cookies, JavaScript, plugins, geolocation, microphone, camera etc.",
    );
  if (has("nativeMessaging"))
    warnings.push("Communicate with cooperating native applications");
  const provider = searchProvider(manifest);
  if (provider) {
    let host = provider.keyword;
    try {
      host = new URL(provider.searchUrl.replace("{searchTerms}", "q")).host;
    } catch {
      // keyword stays
    }
    warnings.push(`Change your search settings to: ${host}`);
  }
  return warnings;
}

/** Warnings in `next` that `previous` did not already show the person. */
export function addedWarnings(previous: string[], next: string[]): string[] {
  const shown = new Set(previous);
  return next.filter((warning) => !shown.has(warning));
}
