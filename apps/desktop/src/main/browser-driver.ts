import { setTimeout as delay } from "node:timers/promises";
import { agentToolResult } from "@catamorphic/sandbox";
import { type WebContents, webContents } from "electron";
import { z } from "zod";
import { BROWSER_GUEST } from "./browser-guest.js";

export type BrowserAction =
  | { type: "click" | "hover"; uid: string }
  | { type: "click" | "hover"; x: number; y: number }
  | { type: "drag"; x: number; y: number; toX: number; toY: number }
  | { type: "fill" | "select"; uid: string; text: string }
  | { type: "press"; key: string }
  | { type: "navigate"; url: string }
  | { type: "read" }
  | { type: "scroll"; direction: "up" | "down" }
  | { type: "wait_for"; text: string; timeoutMs?: number };

export function browserUrl(url: string): string {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error("Browser navigation requires an http(s) URL.");
  return parsed.href;
}

const pointSchema = z.object({ x: z.number(), y: z.number() });
const viewportSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
});
const keyCodes: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  Space: 32,
};

/** One serialized driver per guest. Native input never focuses the host window. */
export class BrowserDriver {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private guest: WebContents,
    private guard: () => void,
    private activity: (active: boolean) => Promise<void>,
  ) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      await this.activity(true);
      const focused =
        webContents.getFocusedWebContents() ?? this.guest.hostWebContents;
      try {
        if (this.guest.isDestroyed())
          throw new Error("Browser tab was closed.");
        this.guest.focus();
        return await operation();
      } finally {
        try {
          if (focused && !focused.isDestroyed()) focused.focus();
        } finally {
          await this.activity(false);
        }
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  private async evaluate(
    method: string,
    args: unknown[] = [],
  ): Promise<unknown> {
    if (this.guest.isDestroyed()) throw new Error("Browser tab was closed.");
    const result = await this.guest.executeJavaScriptInIsolatedWorld(1004, [
      {
        code: `(() => { try { ${BROWSER_GUEST} return {value:globalThis.catamorphicBrowser[${JSON.stringify(method)}](...${JSON.stringify(args)})}; } catch(error) { return {failure: String(error)}; } })()`,
      },
    ]);
    const parsed = z
      .object({ value: z.unknown().optional(), failure: z.string().optional() })
      .parse(result);
    if (parsed.failure) throw new Error(parsed.failure);
    return parsed.value;
  }

  private async input(
    method: string,
    params: Record<string, unknown>,
    release = false,
  ): Promise<void> {
    if (!release) this.guard();
    if (!this.guest.debugger.isAttached()) this.guest.debugger.attach("1.3");
    if (method.startsWith("Input."))
      await this.guest.debugger.sendCommand(
        "Emulation.setFocusEmulationEnabled",
        { enabled: true },
      );
    await this.guest.debugger.sendCommand(method, params);
  }

  snapshot(format: "dom" | "image" = "dom"): Promise<unknown> {
    return this.serial(async () => {
      if (format === "dom") return this.evaluate("snapshot");
      const viewport = viewportSchema.parse(await this.evaluate("viewport"));
      const image = await this.guest.capturePage(undefined, {
        stayHidden: true,
        stayAwake: true,
      });
      if (image.isEmpty())
        throw new Error(
          "Page image is not ready. Wait for the page to render.",
        );
      const width = Math.min(Math.round(viewport.width), 1600);
      const scaled = image.resize({ width });
      const size = scaled.getSize();
      return agentToolResult({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              url: this.guest.getURL(),
              viewport,
              image: size,
              coordinateSpace:
                "CSS viewport pixels; scale screenshot coordinates by viewport.width / image.width.",
            }),
          },
          {
            type: "image",
            mimeType: "image/png",
            data: scaled.toPNG().toString("base64"),
          },
        ],
      });
    });
  }

  read(): Promise<unknown> {
    return this.serial(() => this.evaluate("read"));
  }
  clear(): Promise<unknown> {
    return this.serial(() => this.evaluate("clear"));
  }
  point(
    uid: string,
    note: string | undefined,
    keepPrevious: boolean,
  ): Promise<unknown> {
    return this.serial(() => {
      this.guard();
      return this.evaluate("point", [uid, note, keepPrevious]);
    });
  }

  private async coordinates(point: {
    x: number;
    y: number;
  }): Promise<{ x: number; y: number }> {
    const { width, height } = viewportSchema.parse(
      await this.evaluate("viewport"),
    );
    if (
      ![point.x, point.y].every(Number.isFinite) ||
      point.x < 0 ||
      point.y < 0 ||
      point.x >= width ||
      point.y >= height
    )
      throw new Error(
        "Coordinates are outside the CSS viewport. Take a fresh image snapshot.",
      );
    return { x: point.x, y: point.y };
  }

  private async pointer(
    point: { x: number; y: number },
    click: boolean,
  ): Promise<void> {
    const position = await this.coordinates(point);
    await this.input("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...position,
    });
    if (!click) return;
    await this.input("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...position,
    });
    try {
      this.guard();
    } finally {
      await this.input(
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", button: "left", clickCount: 1, ...position },
        true,
      );
    }
  }

  private async press(key: string): Promise<void> {
    const parts = key.split("+");
    const raw = parts.pop() ?? "";
    if (!Object.hasOwn(keyCodes, raw) && !/^[a-z0-9]$/i.test(raw))
      throw new Error(`Unsupported key: ${key}. Use fill to insert text.`);
    this.guard();
    const electronModifiers = parts
      .map(
        (part) =>
          (
            ({
              Alt: "alt",
              Control: "control",
              Ctrl: "control",
              Meta: "meta",
              Command: "meta",
              Shift: "shift",
            }) as const
          )[part],
      )
      .map((part) => {
        if (part === undefined) throw new Error("Unknown key modifier");
        return part;
      });
    this.guest.sendInputEvent({
      type: "keyDown",
      keyCode:
        {
          ArrowLeft: "Left",
          ArrowRight: "Right",
          ArrowUp: "Up",
          ArrowDown: "Down",
        }[raw] ?? raw,
      modifiers: electronModifiers,
    });
    this.guest.sendInputEvent({
      type: "keyUp",
      keyCode:
        {
          ArrowLeft: "Left",
          ArrowRight: "Right",
          ArrowUp: "Up",
          ArrowDown: "Down",
        }[raw] ?? raw,
      modifiers: electronModifiers,
    });
  }

  act(action: BrowserAction): Promise<unknown> {
    return this.serial(async () => {
      this.guard();
      try {
        switch (action.type) {
          case "read":
            return this.evaluate("read");
          case "navigate":
            await this.guest.loadURL(browserUrl(action.url));
            return { ok: true, url: this.guest.getURL() };
          case "click":
          case "hover": {
            const point =
              "uid" in action
                ? pointSchema.parse(
                    await this.evaluate("prepare", [action.uid]),
                  )
                : action;
            await this.pointer(point, action.type === "click");
            break;
          }
          case "fill":
            await this.evaluate("prepare", [action.uid, true]);
            this.guest.selectAll();
            this.guard();
            // Chromium performs replacement and emits genuine editing events.
            if (action.text === "") await this.press("Backspace");
            else await this.guest.insertText(action.text);
            break;
          case "select":
            this.guard();
            return this.evaluate("select", [action.uid, action.text]);
          case "press":
            await this.press(action.key);
            break;
          case "scroll": {
            const { width, height } = viewportSchema.parse(
              await this.evaluate("viewport"),
            );
            await this.input("Input.dispatchMouseEvent", {
              type: "mouseWheel",
              x: width / 2,
              y: height / 2,
              deltaX: 0,
              deltaY: height * (action.direction === "up" ? -0.8 : 0.8),
            });
            break;
          }
          case "drag": {
            const from = await this.coordinates(action);
            const to = await this.coordinates({ x: action.toX, y: action.toY });
            await this.input("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: from.x,
              y: from.y,
            });
            await this.input("Input.dispatchMouseEvent", {
              type: "mousePressed",
              button: "left",
              buttons: 1,
              clickCount: 1,
              x: from.x,
              y: from.y,
            });
            try {
              for (let step = 1; step <= 8; step++)
                await this.input("Input.dispatchMouseEvent", {
                  type: "mouseMoved",
                  button: "left",
                  buttons: 1,
                  x: from.x + ((to.x - from.x) * step) / 8,
                  y: from.y + ((to.y - from.y) * step) / 8,
                });
            } finally {
              await this.input(
                "Input.dispatchMouseEvent",
                { type: "mouseReleased", button: "left", clickCount: 1, ...to },
                true,
              );
            }
            break;
          }
          case "wait_for": {
            const timeout = action.timeoutMs ?? 5000;
            if (!Number.isFinite(timeout) || timeout < 1 || timeout > 10000)
              throw new Error("timeoutMs must be between 1 and 10000.");
            const deadline = Date.now() + timeout;
            const generation = await this.evaluate("generation");
            do {
              this.guard();
              if (
                this.guest.isDestroyed() ||
                (await this.evaluate("generation")) !== generation
              )
                throw new Error(
                  "Page changed while waiting. Take a fresh snapshot.",
                );
              const page = z
                .object({ text: z.string() })
                .parse(await this.evaluate("read"));
              if (page.text.includes(action.text)) return { found: true };
              await delay(Math.min(100, Math.max(0, deadline - Date.now())));
            } while (Date.now() < deadline);
            return { found: false };
          }
        }
        return { ok: true };
      } finally {
        if (!this.guest.isDestroyed() && this.guest.debugger.isAttached())
          await this.guest.debugger
            .sendCommand("Emulation.setFocusEmulationEnabled", {
              enabled: false,
            })
            .catch(() => {});
      }
    });
  }
}
