import path from "node:path";
import { siteOrigin } from "../shared/site-settings.js";
import type { WindowImageRequest } from "../shared/window-images.js";

/** A site icon larger than this is not an icon. */
const ICON_BYTES = 512 * 1024;
/** A catalog's icon. */
const IMAGE_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const CACHED = 500;

const ICON_TYPES: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

/**
 * The icons the window draws for rows, chips and connections (ADR 0277).
 * Those are text an agent may have written, so the window never loads
 * their addresses itself: main fetches only icons it learned on its own,
 * the ones this profile's tabs showed or history kept, and the icons in
 * catalogs Work fetched. Fetches carry no cookies; answers are data URLs.
 */
export class WindowImages {
  private readonly listed = new Set<string>();
  private readonly cache = new Map<string, Promise<string | null>>();

  constructor(
    private readonly deps: {
      /** The icons this profile saw for a site, most fitting first. */
      siteIcons: (profileId: string, origin: string) => readonly string[];
      /** This profile saw a page show this icon. */
      seenIcon: (profileId: string, icon: string) => boolean;
      fetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
    },
  ) {}

  /** A catalog Work fetched names this icon; the window may show it. */
  list(url: string): void {
    if (!webAddress(url)) return;
    this.listed.add(url);
    if (this.listed.size > 4 * CACHED) {
      const oldest = this.listed.values().next().value;
      if (oldest !== undefined) this.listed.delete(oldest);
    }
  }

  /** The image as a data URL, or null when the window may not show it. */
  async image(
    profileId: string,
    request: WindowImageRequest,
  ): Promise<string | null> {
    if ("site" in request) {
      const { page, icon: reported } = request.site;
      const origin = page ? siteOrigin(page) : null;
      const known = origin ? this.deps.siteIcons(profileId, origin) : [];
      const icon =
        reported &&
        (known.includes(reported) || this.deps.seenIcon(profileId, reported))
          ? reported
          : known[0];
      if (!icon) return null;
      if (inlineImage(icon)) return icon;
      return webAddress(icon) ? this.fetched(icon, ICON_BYTES) : null;
    }
    if (inlineImage(request.url)) return request.url;
    if (!webAddress(request.url) || !this.listed.has(request.url)) return null;
    return this.fetched(request.url, IMAGE_BYTES);
  }

  /** A remote icon as inline data, kept with what it decorates. */
  async inline(url: string): Promise<string | null> {
    if (inlineImage(url)) return url;
    if (!webAddress(url)) return null;
    const image = await this.fetched(url, ICON_BYTES);
    return image && image.length <= 96 * 1024 ? image : null;
  }

  private fetched(url: string, limit: number): Promise<string | null> {
    const cached = this.cache.get(url);
    if (cached) {
      // Most recently used last, so the oldest goes first.
      this.cache.delete(url);
      this.cache.set(url, cached);
      return cached;
    }
    const loading = this.download(url, limit);
    this.cache.set(url, loading);
    void loading.then((image) => {
      if (!image) this.cache.delete(url);
    });
    if (this.cache.size > CACHED) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return loading;
  }

  private async download(url: string, limit: number): Promise<string | null> {
    try {
      const response = await this.deps.fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok || !response.body) return null;
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > limit) return null;
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
      const type = imageType(response.headers.get("content-type"), url);
      if (!type) return null;
      return `data:${type};base64,${Buffer.concat(chunks).toString("base64")}`;
    } catch {
      return null;
    }
  }
}

function inlineImage(url: string): boolean {
  return /^data:image\//i.test(url) && url.length <= IMAGE_BYTES;
}

function webAddress(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * What the bytes are, for the data URL. Sites serve icons as anything from
 * `image/x-icon` to `text/plain`; image decoding reads the bytes, so an
 * undeclared type is named by its extension, and SVG (which needs its
 * type) only when it says so.
 */
function imageType(declared: string | null, url: string): string | null {
  const type = declared?.split(";")[0]?.trim().toLowerCase();
  if (type?.startsWith("image/")) return type;
  if (type === "text/html") return null;
  const extension = path.extname(new URL(url).pathname).toLowerCase();
  const byExtension = ICON_TYPES[extension];
  if (byExtension && byExtension !== "image/svg+xml") return byExtension;
  return "image/png";
}
