import {
  BrowserWindow,
  type Display,
  screen,
  systemPreferences,
} from "electron";
import {
  PILL_GLIDE_MS,
  type PillDisplay,
  type PillRect,
  type PillTarget,
  pillGlide,
} from "../shared/pill-geometry.js";
import type { PillNotches } from "./pill-notch.js";

/** The desktop pill's displays, each with the notch its own probe saw. */
export function pillDisplays(notches: PillNotches): PillDisplay[] {
  return screen
    .getAllDisplays()
    .map((display) => pillDisplay(display, notches));
}

export function pillDisplay(
  display: Display,
  notches: PillNotches,
): PillDisplay {
  return {
    id: display.id,
    bounds: display.bounds,
    workArea: display.workArea,
    notch: notches.notchFor(display),
  };
}

/** Reduced motion as the system asks for it, where the system says. */
export function systemReducedMotion(): boolean {
  try {
    return (
      (process.platform === "darwin" || process.platform === "win32") &&
      systemPreferences.getAnimationSettings().prefersReducedMotion
    );
  } catch {
    return false;
  }
}

/** How often a glide moves its window: about one frame at 120 Hz. */
const GLIDE_TICK_MS = 8;

interface Glide {
  from: PillRect;
  to: PillRect;
  velocity: { x: number; y: number };
  started: number;
  timer: ReturnType<typeof setInterval>;
  done?: () => void;
}

/**
 * Moves a pill window to where it rests, critically damped from the speed
 * it was thrown at (ADR 0242). The size changes at once, so what the window
 * draws stays anchored to the edge it grows from; only the position glides.
 * A new glide, or a new target, starts from where the window is drawn.
 */
export class PillGlides {
  private readonly glides = new Map<BrowserWindow, Glide>();

  isGliding(window: BrowserWindow): boolean {
    return this.glides.has(window);
  }

  /** Where the window is headed, while it glides. */
  target(window: BrowserWindow): PillRect | undefined {
    return this.glides.get(window)?.to;
  }

  glide(
    window: BrowserWindow,
    to: PillRect,
    options: {
      velocity?: { x: number; y: number };
      reducedMotion?: boolean;
      done?: () => void;
    } = {},
  ) {
    const running = this.glides.get(window);
    this.stop(window);
    if (window.isDestroyed()) return;
    const from = window.getBounds();
    if (
      options.reducedMotion ||
      (Math.abs(from.x - to.x) < 1 && Math.abs(from.y - to.y) < 1)
    ) {
      window.setBounds(to);
      options.done?.();
      running?.done?.();
      return;
    }
    const glide: Glide = {
      from,
      to,
      velocity: options.velocity ?? { x: 0, y: 0 },
      started: Date.now(),
      timer: setInterval(() => this.step(window), GLIDE_TICK_MS),
      done: () => {
        running?.done?.();
        options.done?.();
      },
    };
    this.glides.set(window, glide);
    // Its size first, where it is: the glide only moves it.
    window.setBounds({ ...from, width: to.width, height: to.height });
  }

  /** A new size or spot for a gliding window: it heads there from here. */
  retarget(window: BrowserWindow, to: PillRect) {
    const glide = this.glides.get(window);
    if (!glide) return false;
    glide.to = to;
    if (!window.isDestroyed())
      window.setBounds({
        ...window.getBounds(),
        width: to.width,
        height: to.height,
      });
    return true;
  }

  stop(window: BrowserWindow) {
    const glide = this.glides.get(window);
    if (!glide) return;
    clearInterval(glide.timer);
    this.glides.delete(window);
  }

  private step(window: BrowserWindow) {
    const glide = this.glides.get(window);
    if (!glide) return;
    if (window.isDestroyed()) {
      this.stop(window);
      return;
    }
    const ms = Date.now() - glide.started;
    const x = pillGlide({
      from: glide.from.x,
      to: glide.to.x,
      velocity: glide.velocity.x,
      ms,
    });
    const y = pillGlide({
      from: glide.from.y,
      to: glide.to.y,
      velocity: glide.velocity.y,
      ms,
    });
    window.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: glide.to.width,
      height: glide.to.height,
    });
    if (ms < PILL_GLIDE_MS) return;
    this.stop(window);
    window.setBounds(glide.to);
    glide.done?.();
  }
}

/**
 * The page that shows where a held pill can land. It is plain markup and
 * script rather than a renderer of the app: it opens instantly, costs
 * little, and takes no input at all, so however it fails it can never
 * stand between a person and their screen.
 */
const TARGETS_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<style>
html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden;cursor:default}
#targets{position:fixed;inset:0;opacity:0;transition:opacity 140ms cubic-bezier(.2,0,0,1)}
#targets.shown{opacity:1}
.target{position:absolute;box-sizing:border-box;border-radius:999px;border:1.5px dashed var(--line);background:var(--fill);
  box-shadow:0 0 0 1px rgba(0,0,0,.22),0 6px 20px rgba(0,0,0,.16);
  transition:background-color 150ms cubic-bezier(.2,0,0,1),border-color 150ms cubic-bezier(.2,0,0,1),box-shadow 150ms cubic-bezier(.2,0,0,1),scale 150ms cubic-bezier(.2,0,0,1)}
.target.lit{border-style:solid;border-color:var(--accent);background:var(--glow);scale:1.06;
  box-shadow:0 0 0 1px var(--accent),0 0 22px var(--halo)}
.target.notch{border-radius:0 0 14px 14px;border-top:none;background:rgba(0,0,0,.55)}
.target.notch.lit{background:#000}
@media (prefers-reduced-motion: reduce){#targets,.target{transition:none}}
</style></head><body><div id="targets"></div><script>
const root=document.getElementById("targets");
window.__pillTargets=(state)=>{
  if(!state){root.classList.remove("shown");return;}
  const s=document.documentElement.style;
  s.setProperty("--accent",state.accent);
  s.setProperty("--line",state.line);
  s.setProperty("--fill",state.fill);
  s.setProperty("--glow",state.glow);
  s.setProperty("--halo",state.halo);
  const keep=new Set();
  for(const t of state.targets){
    keep.add(t.key);
    let el=root.querySelector('[data-key="'+t.key+'"]');
    if(!el){el=document.createElement("div");el.dataset.key=t.key;el.className="target";root.appendChild(el);}
    el.classList.toggle("notch",!!t.notch);
    el.classList.toggle("lit",t.key===state.lit);
    el.style.left=t.rect.x+"px";el.style.top=t.rect.y+"px";
    el.style.width=t.rect.width+"px";el.style.height=t.rect.height+"px";
  }
  for(const el of [...root.children]) if(!keep.has(el.dataset.key)) el.remove();
  requestAnimationFrame(()=>root.classList.add("shown"));
};
</script></body></html>`;

export interface PillTargetsState {
  targets: PillTarget[];
  lit: string | null;
  accent: string;
}

/**
 * The overlay a held pill's landing spots show in: one display-sized,
 * transparent window that never takes the pointer, made on the first drag
 * and kept hidden between drags. On Linux, where a window cannot ignore
 * the pointer while passing moves on, it also takes the shape of the
 * spots it draws.
 */
export class PillTargetsOverlay {
  private window: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private displayId: number | null = null;
  /** A hide before the page loaded must keep it hidden once it has. */
  private wanted = false;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: { shape: boolean }) {}

  /** The overlay, if one was made (tests read its state). */
  get current(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  show(display: PillDisplay, state: PillTargetsState) {
    clearTimeout(this.hideTimer);
    this.wanted = true;
    const window = this.ensure();
    if (this.displayId !== display.id) {
      this.displayId = display.id;
      window.setBounds(display.bounds);
    }
    void this.ready?.then(() => {
      if (window.isDestroyed() || !this.wanted) return;
      if (this.options.shape)
        window.setShape(
          state.targets.map((target) => ({
            x: Math.max(0, Math.floor(target.rect.x - 24)),
            y: Math.max(0, Math.floor(target.rect.y - 24)),
            width: Math.ceil(target.rect.width + 48),
            height: Math.ceil(target.rect.height + 48),
          })),
        );
      void window.webContents
        .executeJavaScript(
          `window.__pillTargets(${JSON.stringify(paint(state))})`,
        )
        .catch(() => {});
      if (!window.isVisible()) window.showInactive();
    });
  }

  hide() {
    this.wanted = false;
    const window = this.current;
    if (!window) return;
    void window.webContents
      .executeJavaScript("window.__pillTargets(null)")
      .catch(() => {});
    clearTimeout(this.hideTimer);
    // After its fade.
    this.hideTimer = setTimeout(() => {
      if (!window.isDestroyed()) window.hide();
    }, 160);
  }

  destroy() {
    clearTimeout(this.hideTimer);
    this.current?.destroy();
    this.window = null;
    this.ready = null;
  }

  private ensure(): BrowserWindow {
    const existing = this.current;
    if (existing) return existing;
    const window = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      enableLargerThanScreen: true,
      fullscreenable: false,
      backgroundColor: "#00000000",
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    // Over the menu bar, for the notch's spot; never a click.
    window.setAlwaysOnTop(true, "status");
    window.setIgnoreMouseEvents(true);
    if (process.platform === "darwin")
      window.excludedFromShownWindowsMenu = true;
    if (process.platform !== "win32")
      window.setVisibleOnAllWorkspaces(true, {
        skipTransformProcessType: true,
      });
    this.ready = window
      .loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(TARGETS_PAGE)}`,
      )
      .catch(() => {});
    window.on("closed", () => {
      if (this.window === window) {
        this.window = null;
        this.ready = null;
        this.displayId = null;
      }
    });
    this.window = window;
    return window;
  }
}

/**
 * The overlay's colours: the profile's accent, and spots that read over
 * any app, light or dark (a frosted dark fill, a light dashed edge, a thin
 * dark outline), since they draw over whatever is behind, not Work.
 */
function paint(state: PillTargetsState) {
  const accent = /^#[0-9a-f]{6}$/i.test(state.accent)
    ? state.accent
    : "#e2632f";
  return {
    targets: state.targets,
    lit: state.lit,
    accent,
    line: "rgba(255,255,255,.72)",
    fill: "rgba(24,24,27,.28)",
    glow: `${accent}26`,
    halo: `${accent}73`,
  };
}

/**
 * macOS moves a frameless window out from under the menu bar when it is
 * shown, when Spaces or displays change and on waking (Companion learned
 * this the hard way). A pill at the notch puts its frame back whenever it
 * has been moved without being asked.
 */
export class PillFrameKeeper {
  private readonly kept = new Map<BrowserWindow, () => PillRect | null>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly options: { isBusy: (window: BrowserWindow) => boolean },
  ) {}

  keep(window: BrowserWindow, expected: () => PillRect | null) {
    if (!this.kept.has(window)) {
      window.on("move", () => this.check(window));
      window.on("show", () => this.check(window));
      window.once("closed", () => this.release(window));
    }
    this.kept.set(window, expected);
    this.timer ??= setInterval(() => {
      for (const kept of this.kept.keys()) this.check(kept);
    }, 1_000);
  }

  release(window: BrowserWindow) {
    this.kept.delete(window);
    if (this.kept.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private check(window: BrowserWindow) {
    const expected = this.kept.get(window)?.();
    if (!expected || window.isDestroyed() || !window.isVisible()) return;
    if (this.options.isBusy(window)) return;
    const bounds = window.getBounds();
    if (
      Math.abs(bounds.x - expected.x) > 1 ||
      Math.abs(bounds.y - expected.y) > 1
    )
      window.setBounds(expected);
  }
}
