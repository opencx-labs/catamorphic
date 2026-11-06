import { useEffect, useState } from "react";
import type { WindowImageRequest } from "../../shared/window-images.js";

/**
 * Icons for rows, chips and connections (ADR 0277): text an agent may have
 * written names them, so they come from main as data URLs, and main
 * decides which may show. Answers are shared by every view of the window;
 * a refusal is asked again after a while, since the site may have been
 * visited since.
 */
const CACHED = 2000;
const REFUSAL_MS = 60_000;
const settled = new Map<string, { image: string | null; at: number }>();
const pending = new Map<string, Promise<string | null>>();

const INLINE = /^data:image\//i;

/** Loaded on first use: views that only render markup never reach main. */
let api: Promise<typeof import("./desktop-api")> | undefined;
const bridge = () => {
  api ??= import("./desktop-api");
  return api;
};

function keyOf(request: WindowImageRequest): string {
  if ("site" in request) {
    let site = request.site.page ?? "";
    try {
      site = new URL(site).origin;
    } catch {
      // Not an address: main answers that with no icon.
    }
    return `site ${site} ${request.site.icon ?? ""}`;
  }
  return `url ${request.url}`;
}

function inline(request: WindowImageRequest): string | null {
  if ("site" in request)
    return request.site.icon && INLINE.test(request.site.icon)
      ? request.site.icon
      : null;
  return INLINE.test(request.url) ? request.url : null;
}

function known(key: string): { image: string | null } | undefined {
  const answer = settled.get(key);
  if (!answer) return undefined;
  if (answer.image === null && Date.now() - answer.at > REFUSAL_MS) {
    settled.delete(key);
    return undefined;
  }
  return answer;
}

/** The image as a data URL, or null when the window may not show it. */
export function windowImage(
  request: WindowImageRequest,
): Promise<string | null> {
  const direct = inline(request);
  if (direct) return Promise.resolve(direct);
  const key = keyOf(request);
  const answer = known(key);
  if (answer) return Promise.resolve(answer.image);
  const loading = pending.get(key);
  if (loading) return loading;
  // A window without main to ask (a test, a broken bridge) shows nothing.
  const next = bridge()
    .then(({ desktopApi }) => desktopApi.windowImage(request))
    .catch(() => null)
    .then((image) => {
      pending.delete(key);
      settled.delete(key);
      settled.set(key, { image, at: Date.now() });
      if (settled.size > CACHED) {
        const oldest = settled.keys().next().value;
        if (oldest !== undefined) settled.delete(oldest);
      }
      return image;
    });
  pending.set(key, next);
  return next;
}

/**
 * The image for a view: a data URL, null when there is none to show, or
 * undefined while main is asked. Null request: nothing to show.
 */
export function useWindowImage(
  request: WindowImageRequest | null,
): string | null | undefined {
  const key = request ? keyOf(request) : null;
  const immediate = request
    ? (inline(request) ?? (key ? known(key)?.image : undefined))
    : null;
  const [image, setImage] = useState<{
    key: string | null;
    image: string | null | undefined;
  }>({ key, image: immediate });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names the request
  useEffect(() => {
    if (!request) {
      setImage({ key, image: null });
      return;
    }
    let live = true;
    void windowImage(request).then((next) => {
      if (live) setImage({ key, image: next });
    });
    return () => {
      live = false;
    };
  }, [key]);
  if (image.key === key) return image.image;
  return immediate;
}
