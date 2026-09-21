// electron-builder renames the macOS helper apps' executables and display
// names to the product, but leaves their CFBundleName as "Electron Helper…".
// macOS reads that key for system prompts raised on a helper's behalf (the
// network service lives in one), so users get asked to allow "Electron".
// Runs before signing, so the rewritten plists are what gets sealed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const productName = context.packager.appInfo.productName;
  const frameworks = path.join(
    context.appOutDir,
    `${productName}.app`,
    "Contents",
    "Frameworks",
  );
  for (const entry of fs.readdirSync(frameworks)) {
    if (!entry.startsWith(`${productName} Helper`) || !entry.endsWith(".app"))
      continue;
    const plist = path.join(frameworks, entry, "Contents", "Info.plist");
    execFileSync("/usr/libexec/PlistBuddy", [
      "-c",
      `Set :CFBundleName ${entry.slice(0, -".app".length)}`,
      plist,
    ]);
  }
}
