import fs from "node:fs";
import path from "node:path";

export type ConfigObject = Record<string, unknown>;
export type ConfigValidator = (value: ConfigObject) => void;

export function readConfigObject(file: string): ConfigObject {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Expected a JSON object");
    return Object.fromEntries(Object.entries(value));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return {};
    throw error;
  }
}

export function writeConfigFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, content);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function writeConfigObject(file: string, value: ConfigObject): void {
  writeConfigFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** One file owns its last valid value. Deletion is a valid reset; invalid edits are not. */
export class ConfigFile {
  private lastValid: ConfigObject = {};
  error: string | undefined;
  constructor(
    readonly file: string,
    private readonly validate: ConfigValidator,
  ) {}

  read(): ConfigObject {
    try {
      const value = readConfigObject(this.file);
      this.validate(value);
      this.lastValid = value;
      this.error = undefined;
    } catch (error) {
      this.error = `${this.file}: ${error instanceof Error ? error.message : String(error)}. Fix this file to apply changes; the last valid configuration is still active.`;
    }
    return structuredClone(this.lastValid);
  }

  write(value: ConfigObject): void {
    // Never hide or destroy an invalid external edit through an unrelated UI save.
    this.validate(readConfigObject(this.file));
    this.validate(value);
    writeConfigObject(this.file, value);
    this.read();
  }
}
