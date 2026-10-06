import { contextBridge } from "electron";

/**
 * `navigator.userAgentData.brands` is the JS-visible twin of the Sec-CH-UA
 * header (rewritten in main/browser.ts, or by main/extensions/brand.ts in a
 * profile with network extensions). Electron reports Chromium only;
 * leaving JS and headers disagreeing is exactly the mismatch a
 * supported-browser check keys on. Injected into the main world (a page's,
 * an extension page's or an extension service worker's) — the preload's
 * isolated world isn't what their scripts read.
 */
interface UaBrand {
  brand: string;
  version: string;
}

interface UaData {
  brands: UaBrand[];
  getHighEntropyValues: (
    hints: string[],
  ) => Promise<{ brands?: UaBrand[]; fullVersionList?: UaBrand[] }>;
}

export function alignClientHintBrands(): void {
  // executeInMainWorld runs in the page's world (where site scripts look);
  // the preload's isolated world is invisible to them. The function body
  // can't close over preload scope, and reads the version there: a service
  // worker's preload realm has no navigator.
  contextBridge.executeInMainWorld({
    func: () => {
      const version = /Chrome\/(\d+)/.exec(navigator.userAgent)?.[1];
      const data = (navigator as Navigator & { userAgentData?: UaData })
        .userAgentData;
      if (!version || !data) return;
      const brands = [
        { brand: "Google Chrome", version },
        { brand: "Chromium", version },
        { brand: "Not;A=Brand", version: "8" },
      ];
      const copy = () => brands.map((brand) => ({ ...brand }));
      // Patch the prototype, not the instance: `navigator.userAgentData`
      // yields a fresh object per access, so an own-property override is
      // discarded on the next read.
      const proto = Object.getPrototypeOf(data) as object;
      Object.defineProperty(proto, "brands", {
        get: copy,
        configurable: true,
      });
      const getHighEntropyValues = data.getHighEntropyValues;
      Object.defineProperty(proto, "getHighEntropyValues", {
        value: function (this: UaData, hints: string[]) {
          return getHighEntropyValues.call(this, hints).then((values) => {
            if (!values.fullVersionList) {
              return { ...values, brands: copy() };
            }
            // Real Chrome lists Google Chrome at the *Chrome* version;
            // mapping the placeholder brand's version onto it (8.0.0.0)
            // is precisely the tell a checker looks for.
            const chromium = values.fullVersionList.find(
              (entry) => entry.brand === "Chromium",
            );
            const fullVersion = chromium?.version ?? version;
            return {
              ...values,
              brands: copy(),
              fullVersionList: [
                { brand: "Google Chrome", version: fullVersion },
                { brand: "Chromium", version: fullVersion },
                { brand: "Not;A=Brand", version: "8.0.0.0" },
              ],
            };
          });
        },
        configurable: true,
        writable: true,
      });
    },
  });
}
