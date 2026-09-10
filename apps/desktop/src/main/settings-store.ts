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

export interface SettingsFiles {
  profile: string;
  project?: string;
  personal?: string;
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
    const read = (layer: SettingsScope) => {
      const { value, error } = this.read(files[layer], layer);
      if (error) errors.push(error);
      return value;
    };
    return resolveSettings({
      profile: read("profile"),
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
  const raw = readSettingsFile(file); // Never overwrite a corrupt file.
  validateSettingsFile(raw, scope);
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(SETTINGS, key))
      throw new Error(`Unknown setting: ${key}`);
    const settingKey = key as SettingKey;
    const definition = SETTINGS[settingKey];
    if (!definition.scopes.includes(scope))
      throw new Error(`${definition.label} is a profile setting`);
    if (value === null) delete raw[key];
    else {
      if (!definition.valid(value))
        throw new Error(`Invalid value for ${definition.label}`);
      raw[key] = settingsLayer({ [key]: value }, scope)[settingKey];
    }
  }
  writeSettingsFile(file, raw);
  return loadSettings(files, scope);
}

export const writeSettingsFile = writeConfigObject;
