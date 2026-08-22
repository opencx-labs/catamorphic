import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type FrameHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * Eval-style e2e: a REAL model-backed agent builds a small app end to end —
 * launch the app with the fake agent OFF, onboard an API-key agent through
 * the real setup wizard, send one precise build prompt, and assert the
 * resulting app actually RENDERS and behaves inside the sandboxed guest
 * iframe (a second CDP session; the page context cannot see into the
 * opaque-origin frame).
 *
 * The prompt deliberately requires localStorage persistence: the guest
 * runtime shims local/sessionStorage (packages/app/src/guest-document.ts)
 * because reading window.localStorage throws in an opaque-origin iframe and
 * used to blank every storage-touching app. This eval pins that whole class.
 *
 * Gated three ways (skip otherwise): CATAMORPHIC_EVAL=1, an
 * ANTHROPIC_API_KEY or OPENAI_API_KEY in the environment, and the local
 * verdaccio registry (project builds resolve @catamorphic/* through it).
 */

const EVAL_PROMPT =
  "Build a brand-new app in this project named eval-todo. Requirements, " +
  "exactly and minimally: a heading with the exact text 'Eval Todos'; a " +
  "text input with placeholder exactly 'Add item'; an Add button that " +
  "appends the typed text to a visible list; persist the list with " +
  "localStorage so it survives while the app stays open. No other " +
  "features, no styling beyond the defaults. Build it with build_app " +
  "(publish it), then open it with open_surface.";

const PROJECT_NAME = "eval-todo-project";
const APP_NAME = "eval-todo";
const ITEM_TEXT = "First eval item";

const evalOn = process.env.CATAMORPHIC_EVAL === "1";
const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
const openaiKey = anthropicKey ? "" : (process.env.OPENAI_API_KEY ?? "");
const apiKey = anthropicKey || openaiKey;
const provider = anthropicKey ? "anthropic" : "openai";
// Cheap-but-capable defaults; the wizard stores the agent, the test pins
// the model (Anthropic/OpenAI ai-sdk agents have no hardcoded default).
const model = anthropicKey ? "claude-haiku-4-5-20251001" : "gpt-5-mini";

// Project app builds install @catamorphic/* from the local verdaccio
// (infra/local-registry). Don't assume it's running — skip loudly.
const registryUp =
  evalOn && apiKey
    ? await fetch("http://localhost:4873/-/ping", {
        signal: AbortSignal.timeout(2_000),
      })
        .then((response) => response.ok)
        .catch(() => false)
    : false;

const skipReason = !evalOn
  ? "CATAMORPHIC_EVAL is not 1"
  : !apiKey
    ? "neither ANTHROPIC_API_KEY nor OPENAI_API_KEY is set"
    : !registryUp
      ? "local registry http://localhost:4873 is down (run infra/local-registry/publish.sh)"
      : null;
if (skipReason) console.warn(`[eval] skipping agent-build eval: ${skipReason}`);
const describeIf = skipReason === null ? describe : describe.skip;

const ARTIFACTS_DIR = path.join(import.meta.dirname, "artifacts");

/** DOM helpers injected into every page eval (same idiom as the e2e files). */
const helpers = `
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const byText = (selector, text) =>
    $$(selector).find((el) => el.textContent.trim().includes(text));
  const visibleDock = () =>
    $$('section[aria-label]').find((el) => !el.inert && el.querySelector('[data-composer-input]'));
  ${setReactValueJs}
  const pressKey = (key, mods = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown',
      { key, bubbles: true, cancelable: true, ...mods }));
`;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describeIf("agent build eval (real model)", () => {
  it("a real agent builds eval-todo and it renders in the sandboxed iframe", {
    retry: 2,
  }, async () => {
    // Fresh app per attempt so a retry never inherits a half-onboarded
    // profile or a half-built project.
    const app = await launchApp({
      env: {
        // Real agents, real sandbox: opt out of the harness default.
        CATAMORPHIC_E2E_FAKE_AGENT: "",
        ...(anthropicKey
          ? { ANTHROPIC_API_KEY: anthropicKey }
          : { OPENAI_API_KEY: openaiKey }),
      },
    });
    const run = <T>(body: string) =>
      app.eval<T>(`(async () => { ${helpers}\n${body} })()`);
    const runWait = <T>(
      body: string,
      opts?: { timeoutMs?: number; label?: string },
    ) => app.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);

    let frame: FrameHandle | undefined;
    try {
      // --- 1. Create a project ---
      await runWait(`return !!byText('button', 'New project');`, {
        timeoutMs: 60_000,
        label: "empty-state New project button",
      });
      await run(`byText('button', 'New project').click(); return true;`);
      await runWait(`return !!$('[data-testid="project-name-input"]');`);
      await run(`
          setReactValue($('[data-testid="project-name-input"]'), '${PROJECT_NAME}');
          return true;
        `);
      await runWait(
        `const btn = $('[data-testid="project-submit"]');
           if (btn && !btn.disabled) { btn.click(); return true; } return false;`,
        { label: "project submit enabled" },
      );

      // --- 2. Onboard a real agent through the setup wizard ---
      // With no agents configured, the wizard auto-opens as a tab once
      // the project workspace exists (DESIGN.md 2026-08-04).
      await runWait(
        `return $$('[data-testid="agent-wizard-api-key"]')
             .some((el) => !el.closest('[inert]'));`,
        { timeoutMs: 60_000, label: "setup wizard tab with API-key option" },
      );
      // Click retries inside the poll (React may still be attaching).
      await runWait(
        `if ($('[data-testid="agent-wizard-key-input"]')) return true;
           $$('[data-testid="agent-wizard-api-key"]')
             .find((el) => !el.closest('[inert]'))?.click();
           return false;`,
        { label: "API-key step open" },
      );
      await run(`
          setReactValue($('[data-testid="agent-wizard-provider"]'), ${JSON.stringify(provider)});
          setReactValue($('[data-testid="agent-wizard-key-input"]'), ${JSON.stringify(apiKey)});
          return true;
        `);
      await runWait(
        `const btn = $('[data-testid="agent-wizard-key-submit"]');
           if (btn && !btn.disabled) { btn.click(); return true; } return false;`,
        { label: "wizard submit enabled" },
      );
      await runWait(
        `return window.catamorphicDesktop.agentsList().then((data) =>
             data.agents.length === 1 &&
             data.agents[0].provider === ${JSON.stringify(provider)} &&
             data.agents[0].hasApiKey);`,
        { timeoutMs: 30_000, label: "API-key agent created" },
      );
      // The wizard stores no model; ai-sdk Anthropic/OpenAI agents need an
      // explicit one (nothing is hardcoded app-side). Pin the cheap one.
      await run(`
          const data = await window.catamorphicDesktop.agentsList();
          await window.catamorphicDesktop.agentsUpdate(
            data.agents[0].id, { model: ${JSON.stringify(model)} });
          return true;
        `);
      await runWait(
        `return window.catamorphicDesktop.agentsList().then((data) =>
             data.agents[0].model === ${JSON.stringify(model)});`,
        { label: "model pinned on the agent" },
      );

      // --- 3. Send the eval prompt in a fresh chat ---
      await runWait(
        `if (visibleDock()) return true;
           pressKey('n', { metaKey: true });
           return false;`,
        { timeoutMs: 30_000, label: "chat dock open" },
      );
      await run(`
          const ta = visibleDock().querySelector('[data-composer-input]');
          setReactValue(ta, ${JSON.stringify(EVAL_PROMPT)});
          ta.closest('form').requestSubmit();
          return true;
        `);

      // --- 4. Wait for the agent to publish the app (the long part) ---
      const serverUrl = await app.eval<string>(
        `window.catamorphicDesktop.getServerState().then((s) => s.url)`,
      );
      const projectId = await app.waitFor<string>(
        `fetch(${JSON.stringify(serverUrl)} + '/api/projects')
             .then((r) => r.json())
             .then((d) => d.items.find((p) => p.name === ${JSON.stringify(PROJECT_NAME)})?.id ?? false)
             .catch(() => false)`,
        { timeoutMs: 30_000, label: "project id via API" },
      );

      interface TurnStatus {
        appRow: { name: string; activeVersionId: string | null } | null;
        errorText: string | null;
        autoRetry: boolean;
        working: boolean;
        tail: string[];
      }
      const pollStatus = () =>
        run<TurnStatus>(`
            const card = $('[data-testid="chat-error-card"]');
            let appRow = null;
            try {
              const res = await fetch(${JSON.stringify(serverUrl)} +
                '/api/projects/' + ${JSON.stringify(projectId)} + '/apps');
              if (res.ok) {
                const rows = await res.json();
                if (Array.isArray(rows)) {
                  appRow = rows.find((a) => a.name === ${JSON.stringify(APP_NAME)}) ?? null;
                }
              }
            } catch {}
            // Visible activity spinners = the turn is still running. Tool
            // failures surface as error cards MID-turn (the model reads the
            // error and iterates), so a card alone never means a dead turn.
            const working = $$('svg.animate-spin').some((el) => {
              let node = el, opacity = 1;
              while (node && node !== document.body) {
                opacity *= parseFloat(getComputedStyle(node).opacity);
                node = node.parentElement;
              }
              return opacity > 0.5;
            });
            return {
              appRow,
              errorText: card ? card.textContent.trim().slice(0, 400) : null,
              autoRetry: !!$('[data-testid="chat-auto-retry"]'),
              working,
              tail: $$('[role="log"] article')
                .slice(-3).map((el) => el.textContent.trim().slice(0, 200)),
            };
          `);

      const publishDeadline = Date.now() + 420_000;
      let published: TurnStatus["appRow"] = null;
      let deadTurnPolls = 0;
      let lastStatus: TurnStatus | undefined;
      while (Date.now() < publishDeadline) {
        const status = await pollStatus();
        lastStatus = status;
        if (status.appRow?.activeVersionId) {
          published = status.appRow;
          break;
        }
        // Fail fast only on a turn that actually DIED: an error card with
        // no auto-retry countdown and no working spinner, sustained across
        // polls (transient cards recover; mid-turn tool errors keep the
        // spinner on while the model fixes itself).
        deadTurnPolls =
          status.errorText && !status.autoRetry && !status.working
            ? deadTurnPolls + 1
            : 0;
        if (deadTurnPolls >= 6) {
          throw new Error(
            `Agent turn failed: ${status.errorText}\n--- timeline tail ---\n${status.tail.join("\n")}`,
          );
        }
        await sleep(5_000);
      }
      if (!published) {
        throw new Error(
          `App "${APP_NAME}" was not published within 420s.\n--- last status ---\n${JSON.stringify(lastStatus, null, 2)}`,
        );
      }
      expect(published.activeVersionId).toBeTruthy();

      // --- 5. The app tab renders: open_surface focused it, the guest
      // iframe is mounted (its src is the served guest document). ---
      await runWait(`return !!$('iframe[src*="/apps/${APP_NAME}/guest"]');`, {
        timeoutMs: 120_000,
        label: "app guest iframe in the workspace",
      });

      // --- 6. Assert INSIDE the sandboxed frame via a second CDP session
      // (the page context cannot read an opaque-origin frame's DOM). ---
      frame = await app.connectToFrame(`/apps/${APP_NAME}/guest`, {
        timeoutMs: 60_000,
      });
      await frame.waitFor(
        `document.body && document.body.innerText.includes('Eval Todos')`,
        { timeoutMs: 90_000, label: "'Eval Todos' heading rendered in-frame" },
      );

      // Drive it: type into the 'Add item' input, click Add, see the item.
      const drove = await frame.eval<string>(`(() => {
          const input = document.querySelector('input[placeholder="Add item"]');
          if (!input) return 'no input[placeholder="Add item"]';
          const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype, 'value').set;
          setter.call(input, ${JSON.stringify(ITEM_TEXT)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          const button = [...document.querySelectorAll('button')]
            .find((el) => el.textContent.trim() === 'Add') ??
            [...document.querySelectorAll('button')]
              .find((el) => el.textContent.includes('Add'));
          if (!button) return 'no Add button';
          button.click();
          return 'ok';
        })()`);
      expect(drove).toBe("ok");
      await frame.waitFor(
        `document.body.innerText.includes(${JSON.stringify(ITEM_TEXT)})`,
        { timeoutMs: 15_000, label: "added item visible in the list" },
      );

      // The localStorage pin: in an opaque-origin frame the bare property
      // read throws without the guest-runtime shim — a round-trip must
      // work, not throw (the pre-fix symptom was a blank app).
      const probe = await frame.eval<string>(`(() => {
          try {
            localStorage.setItem('__eval_probe', 'ok');
            const value = localStorage.getItem('__eval_probe');
            localStorage.removeItem('__eval_probe');
            return String(value);
          } catch (error) {
            return 'THREW: ' + String(error);
          }
        })()`);
      expect(probe).toBe("ok");

      // Diagnostic only (storage schema is the app's choice): what the
      // app persisted after one add.
      const storageSnapshot = await frame.eval<string>(`(() => {
          const entries = [];
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            entries.push(key + '=' + String(localStorage.getItem(key)).slice(0, 120));
          }
          return entries.join(' | ') || '(empty)';
        })()`);
      console.log(`[eval] guest localStorage after add: ${storageSnapshot}`);

      // Durable-storage pin: the shim's debounced write-through persists
      // the snapshot host-side, and a fresh document hydrates from it —
      // the added item must survive a full guest reload.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      frame.close();
      await app.eval(`(() => {
          const f = [...document.querySelectorAll('iframe')]
            .find((el) => el.src.includes('/apps/${APP_NAME}/guest'));
          if (!f) throw new Error('app iframe gone before reload');
          const src = f.src;
          f.src = 'about:blank';
          requestAnimationFrame(() => { f.src = src; });
          return true;
        })()`);
      // The finally below closes whatever `frame` points at.
      frame = await app.connectToFrame(`/apps/${APP_NAME}/guest`, {
        timeoutMs: 30_000,
      });
      await frame.waitFor(
        `document.body && document.body.innerText.includes(${JSON.stringify(ITEM_TEXT)})`,
        { timeoutMs: 30_000, label: "added item survived a guest reload" },
      );
    } catch (error) {
      fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
      const shot = path.join(
        ARTIFACTS_DIR,
        `agent-build-eval-${Date.now()}.png`,
      );
      await app.screenshot(shot).catch(() => {});
      const tail = app.getOutput().split("\n").slice(-40).join("\n");
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `--- screenshot: ${shot} ---\n--- app output tail ---\n${tail}`,
        { cause: error },
      );
    } finally {
      frame?.close();
      await app.stop();
    }
  });
});
