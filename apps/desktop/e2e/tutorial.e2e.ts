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
    `document.querySelector('[aria-hidden="false"] [role="option"][aria-selected="true"]')?.textContent.includes('Onboarding')`,
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

  it("shows the actual shortcuts and keeps the palette step free of extra actions", async () => {
    await click('[data-testid="onboarding-next"]');
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
});
