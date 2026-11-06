import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, openOnboardingStep } from "./harness.js";

let app: AppHandle;
const mod = process.platform === "darwin" ? 4 : 2;
async function click(selector: string) {
  await settled();
  const point = await app.waitFor<{ x: number; y: number }>(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element || element.closest('[inert]')) return false;
    element.scrollIntoView({ block: 'center', behavior: 'instant' });
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  for (const type of ["mousePressed", "mouseReleased"])
    await app.cdp("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      clickCount: 1,
    });
}
async function settled() {
  await app.waitFor(
    `document.getAnimations().every(animation => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity)`,
  );
}
async function palette(query: string) {
  await app.press("p", mod);
  await app.waitFor(
    `document.activeElement?.matches('[aria-hidden="false"] textarea[aria-label="Search commands, pages, and more"]')`,
  );
  await app.insertText(query);
  await app.waitFor(
    `document.activeElement?.closest('[role="dialog"]')?.querySelector('[role="option"][aria-selected="true"]')?.textContent.includes('Onboarding')`,
  );
  await app.press("Enter");
  await app.waitFor(
    `document.querySelector('[data-testid="onboarding"]')?.dataset.onboardingStep === '0'`,
  );
}

beforeAll(async () => {
  app = await launchApp({ firstLaunch: true });
});
afterAll(async () => {
  await app?.stop();
});

describe("the Work tutorial", () => {
  it("opens as a normal closable tab with a plain welcome", async () => {
    await app.waitFor(
      `document.querySelector('[data-testid="onboarding"]')?.dataset.onboardingStep === '0'`,
    );
    expect(
      await app.eval(
        `window.catamorphicDesktop.devWindow('get').then(state => state.maximized)`,
      ),
    ).toBe(true);
    expect(
      await app.eval(
        `window.catamorphicDesktop.getPrefs().then(prefs => ({left:prefs.sidebarOpen,right:prefs.rightSidebarOpen}))`,
      ),
    ).toEqual({ left: false, right: false });
    expect(
      await app.eval(
        `document.querySelector('[data-workspace-content]').getBoundingClientRect().width === window.innerWidth`,
      ),
    ).toBe(true);
    await app.waitFor(
      `document.querySelector('[aria-label="Switch project"]')?.textContent.includes('Default Project') && document.querySelector('[data-dock-host] [data-dock-rail]')?.dataset.dockCollapsed === 'true'`,
    );
    expect(
      await app.eval(
        `document.querySelector('[data-dock-host]')?.dataset.dockSide`,
      ),
    ).toBe("right");
    expect(
      await app.eval(
        `document.querySelector('[data-testid="onboarding"] h1')?.textContent`,
      ),
    ).toBe("Welcome to Work");
    expect(
      await app.eval(
        `document.querySelectorAll('[data-point-key="onboarding:welcome"]').length`,
      ),
    ).toBe(1);
    expect(
      await app.eval(
        `document.querySelectorAll('[data-testid="onboarding"] img').length`,
      ),
    ).toBe(0);
  });

  it("slides left into a live workspace preview and applies a theme everywhere", async () => {
    await click(".onboarding-explore");
    await app.waitFor(
      `document.querySelector('[data-testid="onboarding"]')?.dataset.onboardingStep === '1'`,
    );
    await settled();
    expect(
      await app.eval(
        `(() => { const preview = document.querySelector('.onboarding-workspace-preview').getBoundingClientRect(); return preview.height / preview.width; })()`,
      ),
    ).toBeGreaterThan(0.58);
    expect(
      await app.eval(
        `new DOMMatrix(getComputedStyle(document.querySelector('.onboarding-track')).transform).m41 < 0`,
      ),
    ).toBe(true);
    await click('[data-testid="onboarding-choose-theme"]');
    await app.waitFor(
      `!!document.querySelector('[data-theme-preset="light"]')`,
    );
    await click('[data-theme-preset="light"]');
    await app.waitFor(`document.documentElement.dataset.theme === 'light'`);
    await settled();
    expect(
      await app.eval(
        `getComputedStyle(document.querySelector('.onboarding-preview-main')).backgroundColor === getComputedStyle(document.body).backgroundColor`,
      ),
    ).toBe(true);
    expect(
      await app.eval(
        `document.querySelector('[data-theme-preset="light"]')?.getAttribute('aria-pressed')`,
      ),
    ).toBe("true");
    await click('[aria-labelledby="theme-picker-title"] .button-primary');
    await app.waitFor(
      `!document.querySelector('[aria-labelledby="theme-picker-title"]')`,
    );
    expect(await app.eval(`document.activeElement?.dataset.testid`)).toBe(
      "onboarding-choose-theme",
    );
  });

  it("keeps the page aligned when a control receives focus during the slide", async () => {
    await openOnboardingStep(app, "Welcome");
    await click(".onboarding-explore");
    await app.eval(
      `document.querySelector('[data-testid="onboarding-choose-theme"]').scrollIntoView({block:'center'}); document.querySelector('[data-testid="onboarding-choose-theme"]').focus()`,
    );
    await settled();
    expect(
      await app.eval(
        `(() => { const page = document.querySelector('.onboarding-page:not([inert])').getBoundingClientRect(); const viewport = document.querySelector('.onboarding-viewport').getBoundingClientRect(); return Math.abs(page.left - viewport.left) < 1; })()`,
      ),
    ).toBe(true);
  });

  it("animates the customization disclosure and the whole theme dialog in both directions", async () => {
    await click('[data-testid="onboarding-choose-theme"]');
    await app.waitFor(
      `!!document.querySelector('.theme-editor button[aria-expanded]')`,
    );
    await settled();
    for (const expanded of [true, false]) {
      const frames = await app.eval<
        { height: number; top: number; bottom: number; viewport: number }[]
      >(`new Promise(resolve => {
        const panel = document.querySelector('[aria-labelledby="theme-picker-title"]');
        const toggle = panel.querySelector('.theme-editor button[aria-expanded]');
        const frames = [];
        const start = performance.now();
        const sample = now => {
          const rect = panel.getBoundingClientRect();
          frames.push({height:rect.height,top:rect.top,bottom:rect.bottom,viewport:innerHeight});
          if (now - start < 650) requestAnimationFrame(sample); else resolve(frames);
        };
        toggle.click();
        requestAnimationFrame(sample);
      })`);
      expect(
        new Set(frames.map((frame) => Math.round(frame.height))).size,
      ).toBeGreaterThan(3);
      const first = frames[0];
      const last = frames.at(-1);
      expect(first).toBeDefined();
      expect(last).toBeDefined();
      if (first && last)
        expect(
          expanded ? last.height - first.height : first.height - last.height,
        ).toBeGreaterThan(80);
      for (const frame of frames) {
        expect(frame.top).toBeGreaterThanOrEqual(23);
        expect(frame.bottom).toBeLessThanOrEqual(frame.viewport - 23);
        expect(
          Math.abs(frame.top - (frame.viewport - frame.height) / 2),
        ).toBeLessThan(2);
      }
      expect(
        await app.eval(
          `document.querySelector('.theme-editor button[aria-expanded]').getAttribute('aria-expanded')`,
        ),
      ).toBe(String(expanded));
    }
    await click('[aria-labelledby="theme-picker-title"] .button-primary');
    await app.waitFor(
      `!document.querySelector('[aria-labelledby="theme-picker-title"]')`,
    );
  });

  it("shows the actual shortcuts and keeps the palette step free of extra actions", async () => {
    await openOnboardingStep(app, "Palette");
    await settled();
    expect(
      await app.eval(
        `document.querySelector('[data-testid="onboarding"] h1')?.textContent`,
      ),
    ).toBe("The way to find everything");
    expect(
      await app.eval(
        `document.querySelectorAll('.onboarding-page:not([inert]) .onboarding-copy button').length`,
      ),
    ).toBe(0);
    expect(
      await app.eval(
        `document.querySelector('.onboarding-copy')?.textContent.includes('using the') && !!document.querySelector('.onboarding-copy svg[aria-label="plus"]')`,
      ),
    ).toBe(true);
    const original = await app.eval<Record<string, string>>(
      `window.catamorphicDesktop.getKeybindings()`,
    );
    await app.eval(
      `window.catamorphicDesktop.setKeybindings({...${JSON.stringify(original)},'new-tab':'Cmd+Shift+Y'})`,
    );
    const expected = process.platform === "darwin" ? "⌘⇧Y" : "Ctrl+Shift+Y";
    await app.waitFor(
      `document.querySelector('.onboarding-copy')?.textContent.includes(${JSON.stringify(expected)})`,
    );
    await app.eval(
      `window.catamorphicDesktop.setKeybindings(${JSON.stringify(original)})`,
    );
  });

  it("reopens from tutorial synonyms without duplicating the tab", async () => {
    for (const query of ["tutorial", "onboarding", "getting started"]) {
      await palette(query);
      expect(
        await app.eval(
          `document.querySelectorAll('[data-point-key="onboarding:welcome"]').length`,
        ),
      ).toBe(1);
    }
  });

  it("finishes into a normal New Tab with the add-tab control", async () => {
    await openOnboardingStep(app, "Browser setup");
    await click('[data-testid="onboarding-next"]');
    await app.waitFor(
      `!document.querySelector('[data-testid="onboarding"]') && document.activeElement?.matches('textarea[aria-label="Search commands, pages, and more"]')`,
    );
    expect(
      await app.eval(
        `(() => { const button = document.querySelector('button[aria-label="New tab"]'); return button && button.getBoundingClientRect().width > 0; })()`,
      ),
    ).toBe(true);
    expect(
      await app.eval(`document.body.innerText.includes('Explore Work')`),
    ).toBe(false);
    await palette("onboarding");
  });

  it("respects reduced motion and fits a narrow tab", async () => {
    await app.cdp("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await openOnboardingStep(app, "Theme");
    expect(
      await app.eval(
        `parseFloat(getComputedStyle(document.querySelector('.onboarding-track')).transitionDuration) <= 0.001`,
      ),
    ).toBe(true);
    await app.eval(`window.catamorphicDesktop.devWindow('setSize',700,650)`);
    await settled();
    expect(
      await app.eval(
        `document.querySelector('.onboarding-page:not([inert])').scrollWidth <= document.querySelector('.onboarding-page:not([inert])').clientWidth`,
      ),
    ).toBe(true);
    await app.eval(`window.catamorphicDesktop.devWindow('setSize',1200,800)`);
    await app.cdp("Emulation.setEmulatedMedia", { features: [] });
  });

  it("demonstrates the dock, uses the effective chat shortcut, and explains keyboard bindings", async () => {
    await openOnboardingStep(app, "The dock");
    const demo = ".onboarding-dock-preview";
    expect(
      await app.eval(
        `document.querySelector('.onboarding-copy h1')?.textContent`,
      ),
    ).toBe("Keep your chats handy");
    expect(
      await app.eval(
        `document.querySelector('.onboarding-copy button') === null`,
      ),
    ).toBe(true);
    await app.waitFor(
      `document.querySelector('${demo} [data-dock-rail]')?.dataset.dockCollapsed === 'false'`,
    );
    await settled();
    const expandedCenter = await app.eval<number>(
      `(() => { const rect=document.querySelector('${demo} [data-dock-rail]').getBoundingClientRect(); return rect.x+rect.width/2; })()`,
    );
    expect(
      Math.abs(expandedCenter - (await app.eval<number>("innerWidth/2"))),
    ).toBeLessThan(1);
    await app.waitFor(
      `getComputedStyle(document.querySelector('${demo}')).getPropertyValue('--dock-demo-collapse-x') !== ''`,
    );
    expect(
      await app.eval(`(() => {
      const cursor=document.querySelector('${demo} .onboarding-demo-cursor');
      const animation=cursor.getAnimations()[0];
      const original=animation.currentTime;
      animation.pause(); animation.currentTime=4680;
      try {
        const pointer=cursor.querySelector('svg').getBoundingClientRect();
        const ring=cursor.querySelector('.onboarding-demo-click').getBoundingClientRect();
        const button=document.querySelector('${demo} [data-dock-arrows]').getBoundingClientRect();
        const tip={x:pointer.x+pointer.width/6,y:pointer.y+pointer.height/6};
        return Math.hypot(tip.x-button.x-button.width/2,tip.y-button.y-button.height/2)<1 && Math.hypot(tip.x-ring.x-ring.width/2,tip.y-ring.y-ring.height/2)<1;
      } finally { animation.currentTime=original; animation.play(); }
    })()`),
    ).toBe(true);

    expect(
      await app.eval(
        `getComputedStyle(document.querySelector('[data-testid="onboarding"]')).paddingBottom`,
      ),
    ).toBe("0px");

    await app.waitFor(
      `document.querySelector('${demo} [data-dock-rail]')?.dataset.dockCollapsed === 'true'`,
    );
    await settled();
    expect(
      await app.eval<number>(
        `(() => { const rect=document.querySelector('${demo} [data-dock-rail]').getBoundingClientRect(); return rect.x+rect.width/2; })()`,
      ),
    ).toBeGreaterThan(expandedCenter + 60);

    const original = await app.eval<Record<string, string>>(
      `window.catamorphicDesktop.getKeybindings()`,
    );
    await app.eval(
      `window.catamorphicDesktop.setKeybindings({...${JSON.stringify(original)},'new-floating-chat':'Cmd+Shift+J'})`,
    );
    const label = process.platform === "darwin" ? "⌘⇧J" : "Ctrl+Shift+J";
    await app.waitFor(
      `document.querySelector('.onboarding-copy')?.textContent.includes(${JSON.stringify(label)})`,
    );
    await app.eval(
      `window.catamorphicDesktop.setKeybindings(${JSON.stringify(original)})`,
    );
    await app.cdp("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await app.waitFor(
      `document.querySelector('${demo}')?.dataset.animated === 'false'`,
    );
    await settled();
    expect(
      await app.eval(
        `document.querySelector('${demo}').getAnimations({subtree:true}).some(animation => animation.playState === 'running')`,
      ),
    ).toBe(false);
    await app.cdp("Emulation.setEmulatedMedia", { features: [] });
    await openOnboardingStep(app, "Keyboard shortcuts");
    expect(
      await app.eval(
        `document.querySelector('.onboarding-copy h1')?.textContent`,
      ),
    ).toBe("Move at the speed of thought");
    expect(
      await app.eval(
        `document.querySelector('.onboarding-copy button') === null`,
      ),
    ).toBe(true);
  });

  it("configures an agent in a modal, keeps the step, and reveals the collapsed dock on the right", async () => {
    await app.eval(
      `window.catamorphicDesktop.agentsList().then(data => Promise.all(data.agents.map(agent => window.catamorphicDesktop.agentsRemove(agent.id))))`,
    );
    await openOnboardingStep(app, "AI agents");
    expect(
      await app.eval(
        `!!document.querySelector('[data-dock-host] [data-dock-rail]')`,
      ),
    ).toBe(true);
    expect(
      await app.eval(
        `document.querySelector('.onboarding-copy h1')?.textContent`,
      ),
    ).toBe("Where AI agents can do wonders");
    await click('[data-testid="onboarding-setup-agent"]');
    await app.waitFor(
      `!!document.querySelector('[role="dialog"] [data-testid="agent-wizard-free"]')`,
    );
    expect(
      await app.eval(
        `document.querySelector('[data-testid="onboarding"]')?.dataset.onboardingStep`,
      ),
    ).toBe("2");
    expect(
      await app.eval(
        `!document.querySelector('[data-point-key^="agent-setup:"]')`,
      ),
    ).toBe(true);
    await click('[role="dialog"] [data-testid="agent-wizard-free"]');
    await app.waitFor(
      `document.querySelector('[data-testid="onboarding-setup-agent"]')?.textContent.includes('Agent configured') && !document.querySelector('[role="dialog"] [data-testid="agent-wizard-free"]')`,
    );
    await app.waitFor(
      `document.querySelector('[data-dock-host] [data-dock-rail]')?.dataset.dockCollapsed === 'true'`,
    );
    expect(
      await app.eval(
        `document.querySelector('[data-dock-host]')?.dataset.dockSide`,
      ),
    ).toBe("right");
    await click('[data-dock-host] button[aria-label="Expand chat bubbles"]');
    await app.waitFor(
      `document.querySelector('[data-dock-host] [data-dock-rail]')?.dataset.dockCollapsed === 'false'`,
    );
    await settled();
    expect(
      await app.eval(
        `getComputedStyle(document.querySelector('[data-testid="onboarding"]')).paddingBottom`,
      ),
    ).toBe("64px");
    expect(
      await app.eval(
        `document.querySelector('.onboarding-navigation').getBoundingClientRect().bottom <= document.querySelector('[data-dock-host] [data-dock-rail]').getBoundingClientRect().top`,
      ),
    ).toBe(true);

    await click('[data-dock-host] button[aria-label="New chat"]');
    await app.waitFor(
      `!![...document.querySelectorAll('[data-composer-input]')].find(el => !el.closest('[inert]') && !el.closest('[data-testid="onboarding"]'))`,
    );
    await app.press("m", mod);
    await settled();
    await openOnboardingStep(app, "Theme");
  });

  it("keeps the tutorial while theme customization sets up an agent in another tab", async () => {
    await app.eval(
      `window.catamorphicDesktop.agentsList().then(data => Promise.all(data.agents.map(agent => window.catamorphicDesktop.agentsRemove(agent.id))))`,
    );
    await click('[data-testid="onboarding-choose-theme"]');
    await app.waitFor(`!!document.querySelector('.theme-agent-link')`);
    await click(".theme-agent-link");
    await app.waitFor(
      `!!document.querySelector('[data-point-key="agent-setup:theme"]') && !!document.querySelector('[data-testid="agent-wizard-free"]')`,
    );
    expect(
      await app.eval(
        `document.querySelectorAll('[data-point-key="onboarding:welcome"]').length`,
      ),
    ).toBe(1);
    await click('[data-testid="agent-wizard-free"]');
    await app.waitFor(
      `!![...document.querySelectorAll('[data-composer-input]')].find(element => !element.closest('[inert]')) && !document.querySelector('[data-point-key="agent-setup:theme"]')`,
    );
    await click('[data-point-key="onboarding:welcome"]');
    await app.waitFor(
      `document.querySelector('[data-testid="onboarding"]')?.dataset.onboardingStep === '1'`,
    );
    expect(app.getRendererErrors()).toEqual([]);
  });

  it("finishes into a new palette tab while keeping the customization chat", async () => {
    const chatKeys = await app.eval<string[]>(
      `[...document.querySelectorAll('[data-point-key^="chat:"]')].filter(element => !element.closest('[data-testid="onboarding"]')).map(element => element.dataset.pointKey)`,
    );
    expect(chatKeys.length).toBeGreaterThan(0);
    await openOnboardingStep(app, "Browser setup");
    await click('[data-testid="onboarding-next"]');
    await app.waitFor(
      `!document.querySelector('[data-testid="onboarding"]') && document.activeElement?.matches('textarea[aria-label="Search commands, pages, and more"]')`,
    );
    expect(
      await app.eval(
        `[...document.querySelectorAll('[data-point-key^="chat:"]')].filter(element => !element.closest('[data-testid="onboarding"]')).map(element => element.dataset.pointKey)`,
      ),
    ).toEqual(chatKeys);
    expect(app.getRendererErrors()).toEqual([]);
  });
});
