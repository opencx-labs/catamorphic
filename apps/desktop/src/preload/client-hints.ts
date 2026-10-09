import { contextBridge } from "electron";
import { chromeBrandLists, type UaBrand } from "../shared/chrome-brands.js";

/**
 * `navigator.userAgentData.brands` is the JS-visible twin of the Sec-CH-UA
 * header (rewritten in main/browser.ts, or by main/extensions/brand.ts in a
 * profile with network extensions). Electron reports Chromium only;
 * leaving JS and headers disagreeing is exactly the mismatch a
 * supported-browser check keys on. Injected into the main world (a page's,
 * an extension page's or an extension service worker's) — the preload's
 * isolated world isn't what their scripts read.
 */
interface UaData {
  brands: UaBrand[];
  getHighEntropyValues: (
    hints: string[],
  ) => Promise<{ brands?: UaBrand[]; fullVersionList?: UaBrand[] }>;
  toJSON: () => { brands: UaBrand[] };
}

export function alignClientHintBrands(): void {
  // executeInMainWorld runs in the page's world (where site scripts look);
  // the preload's isolated world is invisible to them. The function body
  // can't close over preload scope, so the lists arrive as its arguments,
  // built from the engine's version exactly as main builds the headers.
  const lists = chromeBrandLists({ fullVersion: process.versions.chrome });
  contextBridge.executeInMainWorld({
    func: (brands: UaBrand[], fullVersionList: UaBrand[]) => {
      const data = (navigator as Navigator & { userAgentData?: UaData })
        .userAgentData;
      if (!data) return;
      const copy = (list: UaBrand[]) => list.map((brand) => ({ ...brand }));
      // Patch the prototype, not the instance: `navigator.userAgentData`
      // yields a fresh object per access, so an own-property override is
      // discarded on the next read.
      const proto = Object.getPrototypeOf(data) as object;
      Object.defineProperty(proto, "brands", {
        get: () => copy(brands),
        configurable: true,
      });
      // JSON.stringify(navigator.userAgentData) reads Chromium's own list
      // through toJSON, which would contradict `brands`.
      const toJSON = data.toJSON;
      Object.defineProperty(proto, "toJSON", {
        value: function (this: UaData) {
          return { ...toJSON.call(this), brands: copy(brands) };
        },
        configurable: true,
        writable: true,
      });
      const getHighEntropyValues = data.getHighEntropyValues;
      Object.defineProperty(proto, "getHighEntropyValues", {
        value: function (this: UaData, hints: string[]) {
          return getHighEntropyValues.call(this, hints).then((values) =>
            values.fullVersionList
              ? {
                  ...values,
                  brands: copy(brands),
                  fullVersionList: copy(fullVersionList),
                }
              : { ...values, brands: copy(brands) },
          );
        },
        configurable: true,
        writable: true,
      });
    },
    args: [lists.brands, lists.fullVersionList],
  });
}
