import {
  resolveSettings,
  SETTINGS,
  type SettingKey,
  type SettingsScope,
  settingsLayer,
  validateSettingsLayer,
} from "../shared/settings.js";
import {
  ConfigFile,
  readConfigObject,
  writeConfigObject,
} from "./config-file.js";
import { validateThemeConfig } from "./theme.js";

export function validateSettingsFile(
  value: Record<string, unknown>,
  layer: SettingsScope,
) {
  validateSettingsLayer(value, layer);
  if (value.theme !== undefined) {
    if (
      !value.theme ||
      typeof value.theme !== "object" ||
      Array.isArray(value.theme)
    )
      throw new Error("Theme must be a JSON object");
    validateThemeConfig(Object.fromEntries(Object.entries(value.theme)));
  }
}

/** Preferences a profile keeps in another profile's prefs.json (ADR 0272). */
export interface SyncedPrefsFile {
  file: string;
  keys: readonly SettingKey[];
}

export interface SettingsFiles {
  profile: string;
  /** Keys of the profile layer that live in an owner's prefs.json. */
  synced?: readonly SyncedPrefsFile[];
  project?: string;
  personal?: string;
}

/** The profile layer: its own file, with each synced key read from its owner. */
export function composeProfileLayer(
  own: Record<string, unknown>,
  synced: ReadonlyArray<{
    value: Record<string, unknown>;
    keys: readonly string[];
  }>,
): Record<string, unknown> {
  const layer = { ...own };
  for (const { value, keys } of synced)
    for (const key of keys) {
      if (Object.hasOwn(value, key)) layer[key] = value[key];
      else delete layer[key];
    }
  return layer;
}

/** The file that holds one profile preference. */
export function profilePrefsFile(
  own: string,
  synced: readonly SyncedPrefsFile[] | undefined,
  key: string,
): string {
  return (
    synced?.find(({ keys }) => keys.some((candidate) => candidate === key))
      ?.file ?? own
  );
}
export function readSettingsFile(
  file: string | undefined,
): Record<string, unknown> {
  return file ? readConfigObject(file) : {};
}

/** Scoped file caches belong to the profile manager, never process-global state. */
export class SettingsStore {
  private readonly files = new Map<string, ConfigFile>();
  read(file: string | undefined, layer: SettingsScope) {
    if (!file) return { value: {}, error: undefined };
    let store = this.files.get(file);
    if (!store) {
      store = new ConfigFile(file, (value) =>
        validateSettingsFile(value, layer),
      );
      this.files.set(file, store);
    }
    return { value: store.read(), error: store.error };
  }

  load(files: SettingsFiles, scope: SettingsScope = "personal") {
    const errors: string[] = [];
    const readFile = (file: string | undefined, layer: SettingsScope) => {
      const { value, error } = this.read(file, layer);
      if (error) errors.push(error);
      return value;
    };
    const read = (layer: SettingsScope) => readFile(files[layer], layer);
    return resolveSettings({
      profile: composeProfileLayer(
        read("profile"),
        (files.synced ?? []).map(({ file, keys }) => ({
          value: readFile(file, "profile"),
          keys,
        })),
      ),
      project: read("project"),
      personal: read("personal"),
      scope,
      projectAvailable: Boolean(files.project),
      errors,
    });
  }
}

export function loadSettings(
  files: SettingsFiles,
  scope: SettingsScope = "personal",
) {
  return new SettingsStore().load(files, scope);
}

/** null deletes the selected layer's key; unrelated and future keys survive. */
export function saveSettings({
  files,
  scope,
  patch,
}: {
  files: SettingsFiles;
  scope: SettingsScope;
  patch: Record<string, unknown>;
}) {
  const file = files[scope];
  if (!file) throw new Error("This settings scope is unavailable");
  // Never overwrite a corrupt file, including a synced owner's.
  const targets = new Map<string, Record<string, unknown>>();
  const target = (path: string) => {
    let raw = targets.get(path);
    if (!raw) {
      raw = readSettingsFile(path);
      validateSettingsFile(raw, scope);
      targets.set(path, raw);
    }
    return raw;
  };
  target(file);
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(SETTINGS, key))
      throw new Error(`Unknown setting: ${key}`);
    const settingKey = key as SettingKey;
    const definition = SETTINGS[settingKey];
    if (!definition.scopes.includes(scope))
      throw new Error(`${definition.label} is a profile setting`);
    const raw = target(
      scope === "profile" ? profilePrefsFile(file, files.synced, key) : file,
    );
    if (value === null) delete raw[key];
    else {
      if (!definition.valid(value))
        throw new Error(`Invalid value for ${definition.label}`);
      raw[key] = settingsLayer({ [key]: value }, scope)[settingKey];
    }
  }
  for (const [path, raw] of targets) writeSettingsFile(path, raw);
  return loadSettings(files, scope);
}

export const writeSettingsFile = writeConfigObject;
