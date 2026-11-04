import { afterAll, expect, it, vi } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

let app: AppHandle | undefined;
const hour = 60 * 60 * 1000;

afterAll(async () => {
  await app?.stop();
});

it("starts Electron and attaches a target across forward wall-clock corrections", async () => {
  const realNow = Date.now.bind(Date);
  const realFetch = globalThis.fetch;
  let offset = 0;
  const clock = vi
    .spyOn(Date, "now")
    .mockImplementation(() => realNow() + offset);
  // Make the first discovery attempt fail, then move wall time beyond its
  // deadline. Both discovery paths must still try the real CDP endpoint.
  const missOnce = () =>
    vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => {
        offset += hour;
        throw new Error("CDP target not ready yet");
      })
      .mockImplementation(realFetch);
  let discovery = missOnce();
  try {
    app = await launchApp();
    expect(discovery.mock.calls.length).toBeGreaterThanOrEqual(2);
    discovery.mockRestore();
    const url = await app.eval<string>("location.href");
    discovery = missOnce();
    const target = await app.connectToFrame(url);
    try {
      expect(await target.eval("location.href")).toBe(url);
      expect(discovery.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      target.close();
    }
  } finally {
    discovery.mockRestore();
    clock.mockRestore();
  }
});

it.each([hour, -hour])(
  "keeps UI polling bounded when wall time changes by %i ms",
  async (offset) => {
    if (!app) throw new Error("Electron did not start");
    const realNow = Date.now.bind(Date);
    let correction = 0;
    let jumped = false;
    const clock = vi
      .spyOn(Date, "now")
      .mockImplementation(() => realNow() + correction);
    // CDP delivers this event before the first false evaluation's response,
    // so the next poll always observes the correction.
    const unsubscribe = app.onCdpEvent("Runtime.consoleAPICalled", (params) => {
      const event = params as { args?: { value?: unknown }[] };
      if (event.args?.[0]?.value !== "harness-clock-correction") return;
      correction = offset;
      jumped = true;
    });
    try {
      await app.eval("window.__clockPollCount = 0");
      const condition = `(() => {
        const count = ++window.__clockPollCount;
        if (count === 1) console.debug('harness-clock-correction');
        return ${offset > 0 ? "count > 1" : "false"};
      })()`;
      if (offset > 0) {
        expect(await app.waitFor(condition)).toBe(true);
      } else {
        const started = performance.now();
        await expect(
          app.waitFor(condition, { timeoutMs: 400, label: "unmet condition" }),
        ).rejects.toThrow("Timed out (400ms) waiting for unmet condition");
        expect(performance.now() - started).toBeGreaterThanOrEqual(400);
      }
      expect(jumped).toBe(true);
    } finally {
      unsubscribe();
      clock.mockRestore();
      await app.eval("delete window.__clockPollCount");
    }
  },
);
