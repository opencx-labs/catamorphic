/**
 * Toolbar action state (ADR 0203): what `chrome.action` (and MV2's browser
 * and page actions) set, globally and per tab. A tab's values win over the
 * extension's own until the tab closes, as in Chrome.
 */

export type Rgba = [number, number, number, number];

export interface ActionValues {
  title: string;
  /** A data: URL. */
  icon: string | null;
  badgeText: string;
  badgeBackground: Rgba | null;
  badgeTextColor: Rgba | null;
  /** Popup page path relative to the extension root ("" for none). */
  popup: string;
  enabled: boolean;
}

interface ActionState {
  defaults: ActionValues;
  tabs: Map<number, Partial<ActionValues>>;
}

/** Chrome's badge color when an extension sets none. */
export const DEFAULT_BADGE_BACKGROUND: Rgba = [95, 99, 104, 255];

const NAMED: Record<string, Rgba> = {
  black: [0, 0, 0, 255],
  white: [255, 255, 255, 255],
  red: [255, 0, 0, 255],
  green: [0, 128, 0, 255],
  blue: [0, 0, 255, 255],
  yellow: [255, 255, 0, 255],
  orange: [255, 165, 0, 255],
  gray: [128, 128, 128, 255],
  grey: [128, 128, 128, 255],
  purple: [128, 0, 128, 255],
  transparent: [0, 0, 0, 0],
};

/** Chrome accepts a CSS color or an [r, g, b, a] array. */
export function parseColor(value: unknown): Rgba | null {
  if (Array.isArray(value) && value.length === 4) {
    const [r, g, b, a] = value.map(Number);
    const channel = (part: number | undefined): part is number =>
      part !== undefined && Number.isInteger(part) && part >= 0 && part <= 255;
    if (channel(r) && channel(g) && channel(b) && channel(a))
      return [r, g, b, a];
    return null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  const named = NAMED[text];
  if (named) return [...named];
  const hex = /^#([0-9a-f]{3,8})$/.exec(text)?.[1];
  if (hex) {
    const full =
      hex.length <= 4 ? [...hex].map((char) => char + char).join("") : hex;
    if (full.length !== 6 && full.length !== 8) return null;
    const channel = (at: number) => Number.parseInt(full.slice(at, at + 2), 16);
    return [
      channel(0),
      channel(2),
      channel(4),
      full.length === 8 ? channel(6) : 255,
    ];
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(text)?.[1];
  if (rgb) {
    const parts = rgb.split(/[\s,/]+/).filter(Boolean);
    const [r, g, b, a = "1"] = parts;
    const channel = (part: string | undefined) =>
      Math.max(0, Math.min(255, Math.round(Number(part))));
    const alpha = a.endsWith("%") ? Number(a.slice(0, -1)) / 100 : Number(a);
    if ([r, g, b].some((part) => !Number.isFinite(Number(part)))) return null;
    return [
      channel(r),
      channel(g),
      channel(b),
      Math.round(Math.max(0, Math.min(1, alpha)) * 255),
    ];
  }
  return null;
}

export function cssColor(color: Rgba): string {
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${(color[3] / 255).toFixed(3)})`;
}

export class ActionStore {
  private readonly states = new Map<string, ActionState>();

  private key(profileId: string, extensionId: string): string {
    return `${profileId}:${extensionId}`;
  }

  init(profileId: string, extensionId: string, defaults: ActionValues): void {
    this.states.set(this.key(profileId, extensionId), {
      defaults,
      tabs: new Map(),
    });
  }

  has(profileId: string, extensionId: string): boolean {
    return this.states.has(this.key(profileId, extensionId));
  }

  set(
    profileId: string,
    extensionId: string,
    tabId: number | null,
    change: Partial<ActionValues>,
  ): void {
    const state = this.states.get(this.key(profileId, extensionId));
    if (!state) throw new Error("This extension has no action.");
    if (tabId === null) {
      Object.assign(state.defaults, change);
      return;
    }
    state.tabs.set(tabId, { ...(state.tabs.get(tabId) ?? {}), ...change });
  }

  get(
    profileId: string,
    extensionId: string,
    tabId: number | null,
  ): ActionValues | null {
    const state = this.states.get(this.key(profileId, extensionId));
    if (!state) return null;
    const tab = tabId === null ? undefined : state.tabs.get(tabId);
    return { ...state.defaults, ...(tab ?? {}) };
  }

  clearTab(tabId: number): void {
    for (const state of this.states.values()) state.tabs.delete(tabId);
  }

  forget(profileId: string, extensionId: string): void {
    this.states.delete(this.key(profileId, extensionId));
  }
}
