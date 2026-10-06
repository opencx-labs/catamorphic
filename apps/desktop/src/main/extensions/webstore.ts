import crypto from "node:crypto";
import { EXTENSION_ID_PATTERN } from "../../shared/extensions.js";
import {
  type VerifiedCrx,
  verifyCrx,
  WEB_STORE_PUBLISHER_KEY_HASH,
} from "./crx.js";

/**
 * The Chrome Web Store's update service (ADR 0203), spoken the way
 * Chrome's extension updater does for an update check: one GET naming each
 * extension and its installed version, answered with the package each
 * should have, its size and SHA-256.
 */

export const WEB_STORE_UPDATE_URL =
  "https://clients2.google.com/service/update2/crx";
/** The store page origin that may ask Work to install. */
export const WEB_STORE_ORIGIN = "https://chromewebstore.google.com";
/** Largest package Work downloads; the biggest store extensions are ~25 MB. */
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;

export interface StorePackage {
  id: string;
  version: string;
  url: string;
  sha256: string | null;
  size: number | null;
}

export class WebStoreError extends Error {
  override name = "WebStoreError";
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    const [, name, value] = match;
    if (name && value !== undefined)
      result[name] = value
        .replaceAll("&quot;", '"')
        .replaceAll("&apos;", "'")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&");
  }
  return result;
}

/** The packages an update response offers (`status="ok"` checks only). */
export function parseUpdateResponse(xml: string): StorePackage[] {
  const packages: StorePackage[] = [];
  for (const app of xml.matchAll(/<app\b([^>]*)>([\s\S]*?)<\/app>/g)) {
    const id = attributes(app[1] ?? "").appid;
    const check = /<updatecheck\b([^>]*)\/?>/.exec(app[2] ?? "");
    if (!id || !EXTENSION_ID_PATTERN.test(id) || !check) continue;
    const details = attributes(check[1] ?? "");
    if (details.status !== "ok" || !details.codebase || !details.version)
      continue;
    let url: URL;
    try {
      url = new URL(details.codebase);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    const size = Number(details.size);
    packages.push({
      id,
      version: details.version,
      url: url.href,
      sha256: /^[0-9a-f]{64}$/i.test(details.hash_sha256 ?? "")
        ? (details.hash_sha256 ?? "").toLowerCase()
        : null,
      size: Number.isSafeInteger(size) && size > 0 ? size : null,
    });
  }
  return packages;
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export interface WebStoreOptions {
  updateUrl: string;
  publisherKeyHashes: readonly string[];
  chromeVersion: string;
  fetch: (url: string) => Promise<Response>;
}

export function webStoreOptions(
  fetcher: WebStoreOptions["fetch"],
): WebStoreOptions {
  // Test runs point at a local store signed by a test publisher key.
  const e2e = Boolean(process.env.CATAMORPHIC_E2E_DATA_DIR);
  const testUrl = e2e ? process.env.CATAMORPHIC_E2E_WEBSTORE_UPDATE_URL : "";
  const testKey = e2e
    ? process.env.CATAMORPHIC_E2E_WEBSTORE_PUBLISHER_KEY_HASH
    : "";
  return {
    updateUrl: testUrl || WEB_STORE_UPDATE_URL,
    publisherKeyHashes: testKey ? [testKey] : [WEB_STORE_PUBLISHER_KEY_HASH],
    chromeVersion: process.versions.chrome ?? "152.0.0.0",
    fetch: fetcher,
  };
}

export class WebStore {
  constructor(private readonly options: WebStoreOptions) {}

  /** The store's newest package for each extension newer than its version. */
  async check(
    installed: readonly { id: string; version: string }[],
  ): Promise<StorePackage[]> {
    if (installed.length === 0) return [];
    const url = new URL(this.options.updateUrl);
    url.searchParams.set("response", "updatecheck");
    url.searchParams.set("acceptformat", "crx3");
    url.searchParams.set("prodversion", this.options.chromeVersion);
    url.searchParams.set("os", process.platform === "darwin" ? "mac" : "linux");
    url.searchParams.set("arch", process.arch === "arm64" ? "arm64" : "x64");
    for (const { id, version } of installed) {
      const query = new URLSearchParams({ id, v: version, uc: "" });
      url.searchParams.append("x", query.toString());
    }
    const response = await this.options.fetch(url.href);
    if (!response.ok)
      throw new WebStoreError(`The store answered ${response.status}`);
    const versions = new Map(installed.map((entry) => [entry.id, entry]));
    return parseUpdateResponse(await response.text()).filter((offer) => {
      const current = versions.get(offer.id);
      return current && compareVersions(offer.version, current.version) > 0;
    });
  }

  /** The store's current package for one extension, to install it. */
  async latest(id: string): Promise<StorePackage> {
    const [offer] = await this.check([{ id, version: "0.0.0.0" }]);
    if (!offer)
      throw new WebStoreError(
        "This extension is not available from the Chrome Web Store.",
      );
    return offer;
  }

  /** Download and verify a package: size, SHA-256 and every signature. */
  async download(offer: StorePackage): Promise<VerifiedCrx> {
    const response = await this.options.fetch(offer.url);
    if (!response.ok)
      throw new WebStoreError(`The download failed (${response.status})`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_PACKAGE_BYTES)
      throw new WebStoreError("The package is too large");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_PACKAGE_BYTES)
      throw new WebStoreError("The package is too large");
    if (offer.size !== null && bytes.length !== offer.size)
      throw new WebStoreError("The package is incomplete");
    if (
      offer.sha256 !== null &&
      crypto.createHash("sha256").update(bytes).digest("hex") !== offer.sha256
    )
      throw new WebStoreError("The package does not match the store's hash");
    return verifyCrx(bytes, {
      publisherKeyHashes: this.options.publisherKeyHashes,
      expectedId: offer.id,
    });
  }
}
