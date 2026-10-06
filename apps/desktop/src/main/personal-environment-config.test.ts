import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PERSONAL_ENVIRONMENT,
  ensurePersonalEnvironmentConfig,
  PERSONAL_ENVIRONMENT_PATH,
  PERSONAL_FILE_MAX_BYTES,
  PERSONAL_FILES_MAX,
  PERSONAL_SETUP_MAX_LENGTH,
  parsePersonalEnvironmentConfig,
  personalFilePathProblem,
  projectRelativePath,
  readListedFiles,
  readPersonalEnvironmentConfig,
  updatePersonalEnvironmentConfig,
} from "./personal-environment-config.js";

const dirs: string[] = [];
const project = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "personal-env-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("parsePersonalEnvironmentConfig", () => {
  it("reads files, dropping duplicates", () => {
    expect(
      parsePersonalEnvironmentConfig(
        JSON.stringify({ files: [".env", "apps/api/.env.local", ".env"] }),
      ),
    ).toEqual({
      ok: true,
      config: { files: [".env", "apps/api/.env.local"] },
    });
  });

  it("reads the member's own setup command, and none when blank", () => {
    expect(
      parsePersonalEnvironmentConfig(
        JSON.stringify({ files: [".env"], setup: "mise install" }),
      ),
    ).toEqual({
      ok: true,
      config: { files: [".env"], setup: "mise install" },
    });
    expect(
      parsePersonalEnvironmentConfig(JSON.stringify({ setup: "  " })),
    ).toEqual({ ok: true, config: { files: [] } });
    for (const setup of [["mise install"], 1])
      expect(parsePersonalEnvironmentConfig(JSON.stringify({ setup }))).toEqual(
        {
          ok: false,
          error: expect.stringContaining('"setup" must be a shell command'),
        },
      );
    expect(
      parsePersonalEnvironmentConfig(
        JSON.stringify({ setup: "x".repeat(PERSONAL_SETUP_MAX_LENGTH + 1) }),
      ),
    ).toEqual({ ok: false, error: expect.stringContaining("longer than") });
  });

  it("defaults to no files when the key is absent", () => {
    expect(parsePersonalEnvironmentConfig("{}")).toEqual({
      ok: true,
      config: DEFAULT_PERSONAL_ENVIRONMENT,
    });
  });

  it("refuses a logins list: sign-ins stay on the machine", () => {
    for (const text of ['{"logins": []}', '{"logins": ["codex"], "files": []}'])
      expect(parsePersonalEnvironmentConfig(text)).toEqual({
        ok: false,
        error: expect.stringContaining('Remove "logins"'),
      });
  });

  it.each([
    ["not json", "is not valid JSON"],
    ["[]", "must be a JSON object"],
    ['{"file": [".env"]}', 'Unknown key "file"'],
    ['{"files": ".env"}', '"files" must be a list'],
    ['{"files": [1]}', "must be text paths"],
    ['{"files": ["../secrets"]}', "outside the project folder"],
    ['{"files": ["/etc/passwd"]}', "is absolute"],
    ['{"files": ["C:/x"]}', "is absolute"],
    ['{"files": [".git/config"]}', "inside Git's own folder"],
    ['{"files": ["apps\\\\api\\\\.env"]}', "backslashes"],
    ['{"files": ["./.env"]}', "not a plain project path"],
    ['{"files": ["a//b"]}', "not a plain project path"],
  ])("refuses %s", (text, error) => {
    const parsed = parsePersonalEnvironmentConfig(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(error);
  });

  it("caps the number of files", () => {
    const files = Array.from(
      { length: PERSONAL_FILES_MAX + 1 },
      (_, i) => `f${i}`,
    );
    const parsed = parsePersonalEnvironmentConfig(JSON.stringify({ files }));
    expect(parsed).toEqual({
      ok: false,
      error: `List at most ${PERSONAL_FILES_MAX} files`,
    });
  });

  it("uses no dashes in its messages", () => {
    for (const text of [
      "x",
      '{"a":1}',
      '{"logins":["x"]}',
      '{"files":[".."]}',
    ]) {
      const parsed = parsePersonalEnvironmentConfig(text);
      if (!parsed.ok) expect(parsed.error).not.toMatch(/[\u2013\u2014]/);
    }
    expect(personalFilePathProblem("nested/.git/x")).toContain("Git");
  });
});

describe("config file", () => {
  it("reads defaults when absent, writes atomically, and excludes the folder from Git", async () => {
    const root = project();
    const absent = await readPersonalEnvironmentConfig({ root });
    expect(absent).toMatchObject({ exists: false, fingerprint: "absent" });
    await updatePersonalEnvironmentConfig({
      root,
      update: (config) => ({ ...config, files: [".env"] }),
    });
    const written = JSON.parse(
      fs.readFileSync(path.join(root, PERSONAL_ENVIRONMENT_PATH), "utf8"),
    );
    expect(written).toEqual({ files: [".env"] });
    expect(
      fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8"),
    ).toContain("/.work/personal/");
    expect(
      fs
        .readdirSync(path.join(root, ".work", "personal"))
        .filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
    const present = await readPersonalEnvironmentConfig({ root });
    expect(present.exists).toBe(true);
    expect(present.fingerprint).not.toBe("absent");
  });

  it("keeps the setup command when files are added", async () => {
    const root = project();
    const file = path.join(root, PERSONAL_ENVIRONMENT_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ setup: "mise install" }));
    await updatePersonalEnvironmentConfig({
      root,
      update: (config) => ({ ...config, files: [".env"] }),
    });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      files: [".env"],
      setup: "mise install",
    });
  });

  it("never overwrites a broken file", async () => {
    const root = project();
    const file = path.join(root, PERSONAL_ENVIRONMENT_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ nope");
    await expect(
      updatePersonalEnvironmentConfig({ root, update: (config) => config }),
    ).rejects.toThrow("Fix .work/personal/environment.json first");
    expect(fs.readFileSync(file, "utf8")).toBe("{ nope");
  });

  it("creates the file only when it is missing", async () => {
    const root = project();
    await ensurePersonalEnvironmentConfig({ root });
    const file = path.join(root, PERSONAL_ENVIRONMENT_PATH);
    fs.writeFileSync(file, '{"files": [".env"]}\n');
    await ensurePersonalEnvironmentConfig({ root });
    expect(fs.readFileSync(file, "utf8")).toBe('{"files": [".env"]}\n');
  });
});

describe("listed files", () => {
  it("reads each file and explains the ones it cannot send", async () => {
    const root = project();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    dirs.push(outside);
    fs.writeFileSync(path.join(root, ".env"), "A=1\n");
    fs.mkdirSync(path.join(root, "apps"));
    fs.writeFileSync(
      path.join(root, "apps", "big"),
      Buffer.alloc(PERSONAL_FILE_MAX_BYTES + 1),
    );
    fs.writeFileSync(path.join(outside, "secret"), "x");
    fs.symlinkSync(path.join(outside, "secret"), path.join(root, "link"));
    const files = await readListedFiles({
      root,
      files: [".env", "missing", "apps/big", "link", "apps"],
    });
    expect(
      files.map(({ path: file, bytes, problem }) => ({
        file,
        bytes,
        problem,
      })),
    ).toEqual([
      { file: ".env", bytes: 4, problem: null },
      {
        file: "missing",
        bytes: null,
        problem: "Not found in the project folder",
      },
      {
        file: "apps/big",
        bytes: PERSONAL_FILE_MAX_BYTES + 1,
        problem: "Larger than 256 KB",
      },
      {
        file: "link",
        bytes: null,
        problem: "Links outside the project folder",
      },
      { file: "apps", bytes: null, problem: "Not a file" },
    ]);
    expect(files[0]?.content?.toString()).toBe("A=1\n");
    expect(files[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("turns a picked path into a project path and refuses others", async () => {
    const root = project();
    fs.mkdirSync(path.join(root, "apps", "api"), { recursive: true });
    fs.writeFileSync(path.join(root, "apps", "api", ".env.local"), "B=2");
    await expect(
      projectRelativePath({
        root,
        absolute: path.join(root, "apps", "api", ".env.local"),
      }),
    ).resolves.toBe("apps/api/.env.local");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    dirs.push(outside);
    fs.writeFileSync(path.join(outside, "x"), "");
    await expect(
      projectRelativePath({ root, absolute: path.join(outside, "x") }),
    ).rejects.toThrow("inside this project's folder");
    fs.writeFileSync(path.join(root, ".git", "config"), "");
    await expect(
      projectRelativePath({
        root,
        absolute: path.join(root, ".git", "config"),
      }),
    ).rejects.toThrow("inside Git's own folder");
  });
});
