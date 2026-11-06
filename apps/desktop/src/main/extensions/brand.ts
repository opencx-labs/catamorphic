import fs from "node:fs";
import path from "node:path";

/**
 * Work's Sec-CH-UA brands for profiles with network extensions (ADR 0203).
 *
 * Electron runs extension `webRequest` and `declarativeNetRequest` only in
 * a session without its own `webRequest` listener, and the brand rewrite of
 * ADR 0194 is such a listener. A profile whose extensions filter requests
 * drops the listener and loads this hidden extension instead: one
 * declarativeNetRequest session rule sets the same headers, in the network
 * stack, for the same request types. Its key fixes its id wherever the
 * folder is written.
 */

export const BRAND_EXTENSION_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtYP9/BpuyJF2hQ3QMuHObr4awoUCG40QEU05F9i/0Hkx76er3TGa4u46ZStTb251Vkm1Q+ASAFc/93hZPZirwAm+tI4itRbkPQfhBwpFd5Vz2zDv3WyCrLcM4bm0k4P9WbE7MrxQbT3HTYmr2oXrH2MZRP1+veUcdAve7t8RRyeN0Jc7iAkt2UyXgiafaq6861DmMEPnIYYsG1WkG5MSY5BrLK3GGwMvDrfxVdanuoWic8YK7gILmsSpxnu5PwzWbPARVNBGmV1aRvHIfdlqB+JG/V8SGaCQNXL/GPVh+x2gDrAlUXBQ+BY/X0V3cqeM9wUpQSTdp+KY8pAx8S9KOQIDAQAB";
export const BRAND_EXTENSION_ID = "kekikcpnaodjcmdjlecmnlpoibomeahd";

/** The permissions that make a profile's requests pass through extensions. */
export const NETWORK_PERMISSIONS = new Set([
  "webRequest",
  "webRequestBlocking",
  "declarativeNetRequest",
  "declarativeNetRequestWithHostAccess",
  "declarativeNetRequestFeedback",
]);

export function brandWorkerSource(brands: {
  brands: string;
  fullVersionList: string;
}): string {
  const rule = (id: number, header: string, value: string) => ({
    id,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header, operation: "set", value }],
    },
    // Chrome sends client hints to potentially trustworthy origins only:
    // https, and http on the loopback host.
    condition: {
      regexFilter: "^(https://|http://(localhost|127\\.0\\.0\\.1)[:/])",
      resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest"],
    },
  });
  const rules = [
    rule(1, "sec-ch-ua", brands.brands),
    rule(2, "sec-ch-ua-full-version-list", brands.fullVersionList),
  ];
  return `// Written by Work at startup (ADR 0203). Do not edit.
chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [1, 2],
  addRules: ${JSON.stringify(rules)},
});
`;
}

/** Write (or refresh) the extension's folder; returns it. */
export function writeBrandExtension(
  dir: string,
  brands: { brands: string; fullVersionList: string },
): string {
  const manifest = {
    manifest_version: 3,
    name: "Work browser identity",
    version: "1.0.0",
    key: BRAND_EXTENSION_KEY,
    background: { service_worker: "worker.js" },
    permissions: ["declarativeNetRequest"],
    host_permissions: ["<all_urls>"],
  };
  const files: Record<string, string> = {
    "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "worker.js": brandWorkerSource(brands),
  };
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    let current: string | null = null;
    try {
      current = fs.readFileSync(file, "utf-8");
    } catch {
      current = null;
    }
    if (current !== content) fs.writeFileSync(file, content);
  }
  return dir;
}
