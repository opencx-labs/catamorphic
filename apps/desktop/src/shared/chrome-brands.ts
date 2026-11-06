/**
 * Chrome's client-hint brands (Sec-CH-UA, Sec-CH-UA-Full-Version-List and
 * `navigator.userAgentData`), built the way Chromium builds them:
 * GenerateBrandVersionList and GetGreasedUserAgentBrandVersion in
 * components/embedder_support/user_agent_utils.cc. The major version seeds
 * the placeholder brand, its version and the list's order, so Chrome 156
 * sends `"Not:A-Brand";v="8", "Chromium";v="156", "Google Chrome";v="156"`.
 * Electron builds the same placeholder but leaves Google Chrome out; Work
 * presents the list Chrome itself would (ADR 0150).
 */

export interface UaBrand {
  brand: string;
  version: string;
}

const GREASEY_CHARS = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
const GREASED_VERSIONS = ["8", "99", "24"];
/** Where the placeholder, Chromium and Google Chrome go, by major % 6. */
const ORDERS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

function brandList({
  major,
  version,
  greaseSuffix,
}: {
  major: number;
  version: string;
  /** The full version list writes the placeholder's version as `8.0.0.0`. */
  greaseSuffix: string;
}): UaBrand[] {
  const char = (seed: number) => GREASEY_CHARS[seed % GREASEY_CHARS.length];
  const entries = [
    {
      brand: `Not${char(major)}A${char(major + 1)}Brand`,
      version: `${GREASED_VERSIONS[major % GREASED_VERSIONS.length]}${greaseSuffix}`,
    },
    { brand: "Chromium", version },
    { brand: "Google Chrome", version },
  ];
  const order = ORDERS[major % ORDERS.length] ?? [0, 1, 2];
  return entries
    .map((entry, index) => ({ entry, position: order[index] ?? index }))
    .sort((a, b) => a.position - b.position)
    .map(({ entry }) => entry);
}

/** Chrome's brands and full version list for an engine version ("156.0.8078.12"). */
export function chromeBrandLists({ fullVersion }: { fullVersion: string }): {
  brands: UaBrand[];
  fullVersionList: UaBrand[];
} {
  const major = Number.parseInt(fullVersion, 10);
  return {
    brands: brandList({ major, version: String(major), greaseSuffix: "" }),
    fullVersionList: brandList({
      major,
      version: fullVersion,
      greaseSuffix: ".0.0.0",
    }),
  };
}

/** The same lists as Sec-CH-UA header values. */
export function chromeBrandHeaders({ fullVersion }: { fullVersion: string }): {
  brands: string;
  fullVersionList: string;
} {
  const header = (list: UaBrand[]) =>
    list.map(({ brand, version }) => `"${brand}";v="${version}"`).join(", ");
  const lists = chromeBrandLists({ fullVersion });
  return {
    brands: header(lists.brands),
    fullVersionList: header(lists.fullVersionList),
  };
}
