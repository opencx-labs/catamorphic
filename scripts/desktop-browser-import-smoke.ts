import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyDesktopSignature } from "./desktop-signature.js";
import { toolRuntime } from "./tool-runtime.js";

const fixture = {
  origin: "https://catamorphic-import-smoke.invalid",
  username: "catamorphic-smoke",
  password: "Disposable-test-password-42!",
};
const markerName = ".catamorphic-import-smoke.json";

async function runSmoke(args: string[]) {
  if (args.length === 1 && args[0] === "prepare") {
    const profileDir = await mkdtemp(
      path.join(tmpdir(), "catamorphic-import-smoke-"),
    );
    await writeFile(
      path.join(profileDir, markerName),
      JSON.stringify({ kind: "catamorphic-import-smoke", id: randomUUID() }),
      { mode: 0o600 },
    );
    console.log(JSON.stringify({ profileDir, ...fixture }, null, 2));
    return;
  }
  const [mode, appPath, profileDir, expected] = args;
  if (
    mode !== "verify" ||
    !appPath ||
    !profileDir ||
    args.length !== 4 ||
    !["import", "cancel", "existing"].includes(expected ?? "")
  )
    throw new Error(
      "Usage: bun scripts/desktop-browser-import-smoke.ts prepare | verify <signed app> <disposable Chrome user-data-dir> <import|cancel|existing>",
    );
  if (process.platform !== "darwin")
    throw new Error("This interactive verification requires macOS");
  const signature = verifyDesktopSignature({ appPath });
  const marker = JSON.parse(
    await readFile(path.join(profileDir, markerName), "utf8"),
  );
  if (
    marker.kind !== "catamorphic-import-smoke" ||
    typeof marker.id !== "string"
  )
    throw new Error("Use a disposable profile created by the prepare command");
  const file = path.join(profileDir, "Default", "Login Data");
  for (const entry of [profileDir, path.dirname(file), file])
    if ((await lstat(entry)).isSymbolicLink())
      throw new Error("Smoke profiles must not contain symbolic links");
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = database
      .prepare(
        "SELECT origin_url, username_value FROM logins WHERE blacklisted_by_user = 0",
      )
      .all();
    if (
      rows.length !== 1 ||
      rows[0]?.origin_url !== `${fixture.origin}/` ||
      rows[0]?.username_value !== fixture.username
    )
      throw new Error(
        "The disposable browser must contain exactly the one documented smoke credential",
      );
  } finally {
    database.close();
  }
  const fingerprint = async () => {
    const hash = createHash("sha256");
    for (const filename of [file, `${file}-wal`]) {
      try {
        hash.update(await readFile(filename));
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
    }
    return hash.digest("hex");
  };
  const before = await fingerprint();
  const { importBrowserPasswords, readBrowserKey } = await import(
    "../apps/desktop/src/main/browser-import/password-native.js"
  );
  const source = {
    files: [file],
    keychainService: "Chrome Safe Storage",
    keychainAccount: "Chrome",
  };
  console.log(
    expected === "cancel"
      ? "Cancel the upcoming macOS authentication prompt."
      : expected === "import"
        ? "Authenticate in macOS and authorize the signed helper when prompted."
        : "Checking duplicate handling; no authentication should be requested.",
  );
  let saved = 0;
  const result = await importBrowserPasswords({
    source,
    existing:
      expected === "existing"
        ? [{ origin: fixture.origin, username: fixture.username }]
        : [],
    readKey: () =>
      readBrowserKey({
        helperPath: path.join(appPath, "Contents/MacOS/browser-keychain"),
        source,
      }),
    save: async (credentials) => {
      if (
        credentials.length !== 1 ||
        credentials[0]?.origin !== fixture.origin ||
        credentials[0]?.username !== fixture.username ||
        credentials[0]?.password !== fixture.password
      )
        throw new Error(
          "The browser-written credential did not decrypt to the expected test value",
        );
      saved = credentials.length;
      return { imported: saved, existing: 0 };
    },
  });
  if (before !== (await fingerprint()))
    throw new Error(
      "Source changed during verification; close the disposable browser and retry",
    );
  if (
    result.failed ||
    result.invalid ||
    (expected === "import"
      ? saved !== 1 || result.cancelled
      : expected === "cancel"
        ? !result.cancelled || saved !== 0
        : result.existing !== 1 || saved !== 0)
  )
    throw new Error(`Unexpected smoke result: ${JSON.stringify(result)}`);
  console.log(
    JSON.stringify(
      { verified: expected, ...signature, ...result, sourceUnchanged: true },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  if (process.versions.bun) {
    // The production reader uses node:sqlite. Run the same code on pinned Node,
    // and remove the temporary bundle even when authentication is cancelled.
    const directory = await mkdtemp(
      path.join(tmpdir(), "catamorphic-import-runner-"),
    );
    try {
      const bundle = path.join(directory, "smoke.mjs");
      execFileSync(
        "bun",
        [
          "build",
          import.meta.filename,
          "--target=node",
          "--format=esm",
          "--outfile",
          bundle,
        ],
        { stdio: "pipe" },
      );
      const runtime = toolRuntime({
        rootPath: path.resolve(import.meta.dirname, ".."),
        env: process.env,
      });
      const result = spawnSync(
        runtime.nodePath,
        [bundle, ...process.argv.slice(2)],
        { env: runtime.env, stdio: "inherit" },
      );
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  } else {
    await runSmoke(process.argv.slice(2));
  }
}
