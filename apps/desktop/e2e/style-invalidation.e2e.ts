import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

let app: AppHandle;
beforeAll(async () => {
  app = await launchApp();
  await app.eval(`window.catamorphicDesktop.createProject({
    name: 'Style workload', rootPath: ${JSON.stringify(`${app.userDataDir}/style-workload`)}
  })`);
  await app.reload();
  await app.waitFor("!!document.querySelector('[data-workspace-ready]')");
  await app.eval(`window.dispatchEvent(new KeyboardEvent('keydown', {
    key:'n', metaKey:/Mac/.test(navigator.platform), ctrlKey:!/Mac/.test(navigator.platform), bubbles:true
  })); true`);
  await app.waitFor(
    "!!document.querySelector('[data-chat-local-id]:not([inert]) [data-composer-input]')",
  );
});
afterAll(async () => {
  await app?.stop();
});

it("skips offscreen rows of a live turn, retaining their content through resizing", async () => {
  try {
    await app.eval(`(() => {
      const list = document.createElement('div');
      list.id = 'live-row-workload';
      list.style.cssText = 'position:fixed;inset:100px auto auto 300px;width:600px;height:240px;overflow:auto;background:var(--color-bg)';
      for (let i = 0; i < 100; i++) {
        const row = document.createElement('div');
        row.className = 'cat-row';
        for (let j = 0; j < 80; j++) {
          const text = document.createElement('p');
          text.textContent = 'Work item ' + i + ', output line ' + j;
          row.append(text);
        }
        list.append(row);
      }
      document.body.append(list);
    })()`);
    const skipped = `(() => {
      const list = document.getElementById('live-row-workload');
      return list.firstElementChild.firstElementChild.checkVisibility({contentVisibilityAuto:true}) &&
        !list.lastElementChild.lastElementChild.checkVisibility({contentVisibilityAuto:true});
    })()`;
    await app.waitFor(skipped, { label: "offscreen live work skips layout" });
    await app.eval(`(() => {
      const list = document.getElementById('live-row-workload');
      list.lastElementChild.lastElementChild.textContent = 'Latest preserved output';
      list.style.display = 'none';
    })()`);
    await app.eval(`(() => {
      const list = document.getElementById('live-row-workload');
      list.style.width = '400px'; list.style.display = '';
    })()`);
    await app.waitFor(skipped, {
      label: "resizing retains offscreen containment",
    });
    await app.eval(`(() => {
      const list = document.getElementById('live-row-workload');
      list.lastElementChild.lastElementChild.scrollIntoView({block:'end'});
    })()`);
    await app.waitFor(
      `document.getElementById('live-row-workload').lastElementChild.lastElementChild.checkVisibility({contentVisibilityAuto:true})`,
      {
        label: "scrolling to the work lays it out",
      },
    );
    expect(
      await app.eval(
        "document.getElementById('live-row-workload').lastElementChild.lastElementChild.textContent",
      ),
    ).toBe("Latest preserved output");
  } finally {
    await app.eval("document.getElementById('live-row-workload')?.remove()");
  }
});

it("keeps local insertions out of long chat transcripts' style work", async () => {
  // Real profiles retain tens of thousands of transcript elements. Their
  // data attributes also exercise the selector for the tab's corner controls.
  await app.eval(`(() => {
    const fixture = document.createElement('div'); fixture.id = 'style-workload';
    fixture.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;opacity:0';
    const rows = document.createDocumentFragment();
    for (let i = 0; i < 12000; i++) {
      const row = document.createElement('div'); row.dataset.testid = 'fixture-step';
      row.className = 'cat-markdown'; row.textContent = 'A settled tool result'; rows.append(row);
    }
    fixture.append(rows);
    document.querySelector('[data-chat-local-id]:not([inert])').append(fixture);
    const probe = document.createElement('div'); probe.id = 'style-probe';
    probe.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none';
    document.body.append(probe); probe.offsetHeight;
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  const counts: number[] = [];
  const stopData = app.onCdpEvent("Tracing.dataCollected", (params) => {
    const { value } = params as {
      value: { name: string; args?: { elementCount?: number } }[];
    };
    for (const event of value)
      if (
        event.name === "UpdateLayoutTree" &&
        event.args?.elementCount !== undefined
      )
        counts.push(event.args.elementCount);
  });
  let complete = () => {};
  const ended = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const stopComplete = app.onCdpEvent("Tracing.tracingComplete", () =>
    complete(),
  );
  try {
    await app.cdp("Tracing.start", { categories: "devtools.timeline" });
    await app.eval(`(() => {
      const probe = document.getElementById('style-probe');
      for (const parent of [document.body, document.querySelector('[data-workspace-content]'), document.querySelector('[data-chat-local-id]:not([inert])')]) {
        parent.append(probe); probe.offsetHeight;
        for (let i = 0; i < 4; i++) {
          probe.replaceChildren(document.createElement('span')); probe.offsetHeight;
        }
      }
    })()`);
    await app.cdp("Tracing.end");
    await ended;
    expect(counts.length, "the trace observed style passes").toBeGreaterThan(0);
    expect(
      Math.max(...counts),
      "local changes must not restyle the 12,000 transcript rows",
    ).toBeLessThan(1000);
  } finally {
    stopData();
    stopComplete();
    await app.eval(
      "document.getElementById('style-workload')?.remove(); document.getElementById('style-probe')?.remove()",
    );
  }
  expect(app.getRendererErrors()).toEqual([]);
});
