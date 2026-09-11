import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";
import {
  WORKFLOW_EDITOR_EXPANDED_SOURCE,
  WORKFLOW_EDITOR_SOURCE,
} from "./workflow-fixture.js";

let app: AppHandle;
let projectId: string;
beforeAll(async () => {
  app = await launchApp();
});
afterAll(async () => {
  await app?.stop();
});
const helpers = `const $ = s => document.querySelector(s); const $$ = s => [...document.querySelectorAll(s)]; const button = text => $$('.workflow-workbench button').find(el => !el.closest('[inert]') && el.innerText.trim() === text); ${setReactValueJs}`;
const run = <T>(body: string) =>
  app.eval<T>(`(async () => { ${helpers} ${body} })()`);
const wait = (body: string, label: string) =>
  app.waitFor(`(() => { ${helpers} ${body} })()`, { label });
const writeSource = (content: string) =>
  run(
    `const {url} = await window.catamorphicDesktop.getServerState(); const response = await fetch(url + '/api/projects/${projectId}/files/linked-workflow.ts', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({content:${JSON.stringify(content)}})}); if (!response.ok) throw new Error(await response.text()); return true;`,
  );

afterEach(async (context) => {
  expect(app.getRendererErrors()).toEqual([]);
  if (context.task.result?.state === "fail") {
    console.error("Workflow failure", context.task.result?.errors);
    console.error("SERVER LOG", app.getOutput());

    console.error(
      "Workflow UI:",
      await run(
        `return {tabs:$$('[role="tab"]').map(el=>el.textContent), workbench:$('.workflow-workbench')?.innerText, text:document.body.innerText.slice(0,2200)};`,
      ),
    );
    await app.screenshot(
      `/tmp/workflow-e2e-${context.task.name.slice(0, 5)}.png`,
    );
  }
});
describe("workflow authoring", { retry: 0 }, () => {
  it("opens a readable host inspector and can always reach code", async () => {
    await wait(
      `return !!$$('button').find(el => el.textContent.trim() === 'New project');`,
      "empty workspace",
    );
    await run(
      `$$('button').find(el => el.textContent.trim() === 'New project').click(); return true;`,
    );
    await wait(
      `return !!$('[data-testid="project-name-input"]');`,
      "project form",
    );
    await run(
      `setReactValue($('[data-testid="project-name-input"]'), 'Workflow authoring'); return true;`,
    );
    await wait(
      `const submit=$('[data-testid="project-submit"]'); if(submit && !submit.disabled) {submit.click(); return true;} return false;`,
      "create project",
    );
    await wait(
      `const submit=$('[data-testid="project-submit"]'); return !!$('textarea[placeholder*="Search or ask"]') && (!submit || !!submit.closest('[inert]'));`,
      "project workspace",
    );
    projectId = await run<string>(
      `const {url}=await window.catamorphicDesktop.getServerState(); const data=await fetch(url+'/api/projects').then(r=>r.json()); return data.items.find(p=>p.name==='Workflow authoring').id;`,
    );
    await writeSource(WORKFLOW_EDITOR_SOURCE);

    // Fixture writes happen outside the app's query cache. Reload once before
    // beginning the interaction checks, just as a fresh workspace opens.
    await app.reload();
    await wait(
      `return document.readyState === "complete";`,
      "fresh workspace after fixture reload",
    );
    await wait(
      `const row=$$('button').find(el=>el.textContent.trim()==='Weekly report'); if(row){row.click();return true;} return false;`,
      "open workflow from sidebar",
    );

    await wait(
      `return $('.workflow-header h1')?.textContent === 'Weekly report' && $$('.react-flow__node').length === 4;`,
      "workflow graph",
    );
    expect(
      await run(`return $('[data-testid="workflow-details"]').innerText;`),
    ).toContain("Gather the week's notes");
    await run(`button('View code').click(); return true;`);
    await wait(
      `return !!$('.workflow-workbench .monaco-editor');`,
      "workflow source editor",
    );
    for (const selection of ["dark", "light"]) {
      await app.eval(
        `window.catamorphicDesktop.setTheme({selection:${JSON.stringify(selection)},overrides:{}})`,
      );
      await wait(
        `const editor=$('.monaco-editor'); const probe=document.createElement('span'); probe.style.color='var(--color-bg)'; editor.append(probe); const expected=getComputedStyle(probe).color; probe.remove(); return getComputedStyle(editor).backgroundColor===expected;`,
        "editor follows host background",
      );
      await wait(
        `const keyword=$$('.monaco-editor .view-lines span').find(el=>el.children.length===0 && el.textContent.trim()==='import'); if(!keyword) return false; const probe=document.createElement('span'); probe.style.color='var(--color-accent)'; keyword.parentElement.append(probe); const expected=getComputedStyle(probe).color; probe.remove(); return getComputedStyle(keyword).color===expected;`,
        "syntax follows host accent",
      );
      await app.waitFor(
        `!document.getAnimations().some(a => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity)`,
      );
      await app.screenshot(`/tmp/catamorphic-editor-${selection}.png`);
    }
    await app.eval(
      `window.catamorphicDesktop.setTheme({selection:'dark',overrides:{}})`,
    );
    await run(`button('Details').click(); return true;`);
    await wait(
      `return !!$('[data-testid="workflow-details"]');`,
      "return to overview",
    );
  });

  it("fits a workflow restored in a background tab on its first visible measurement", async () => {
    await run(
      `window.dispatchEvent(new KeyboardEvent('keydown',{key:'t',altKey:true,metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true,cancelable:true})); return true;`,
    );
    await wait(
      `return !!$('.workflow-workbench')?.closest('.hidden');`,
      "workflow in background",
    );
    // Reload only after the host has persisted the selected background arrangement.
    await app.waitFor(
      `window.catamorphicDesktop.workspaceStateGet('${projectId}').then(state => state?.activeTabKey?.startsWith('browser:'))`,
      { label: "background tab saved" },
    );
    await run(
      `window.workflowBeforeReload=true; location.reload(); return true;`,
    );
    await wait(
      `return !window.workflowBeforeReload && !!$('.workflow-workbench')?.closest('.hidden') && $$('.react-flow__node').length === 4;`,
      "background workflow restored",
    );
    await run(
      `$('[data-point-key="workflow:linkedWorkflow"] button').click(); return true;`,
    );
    await wait(
      `const canvas=$('.catamorphic-workflow-canvas[data-viewport-ready="true"]')?.getBoundingClientRect(); const nodes=$$('.react-flow__node').map(node=>node.getBoundingClientRect()); return canvas?.width > 0 && nodes.length === 4 && nodes.every(node=>node.width > 0 && node.left >= canvas.left - 1 && node.right <= canvas.right + 1 && node.top >= canvas.top - 1 && node.bottom <= canvas.bottom + 1);`,
      "workflow nodes fit visible canvas",
    );
  });

  it("preserves the canvas and viewport through panel changes and external edits", async () => {
    await run(
      `window.workflowCanvas = $('.react-flow'); window.workflowViewport = $('.react-flow__viewport').style.transform; return true;`,
    );
    await run(
      `$('button[aria-label="Hide workflow inspector"]').click(); return true;`,
    );
    await wait(
      `return $('.workflow-stage').dataset.inspectorOpen === 'false';`,
      "inspector closed",
    );
    await run(
      `$('button[aria-label="Show workflow inspector"]').click(); return true;`,
    );
    expect(await run(`return $('.react-flow')===window.workflowCanvas;`)).toBe(
      true,
    );
    await run(
      `window.workflowSawMotion=false; window.workflowMotionObserver=new MutationObserver(()=>{if($('[data-graph-transitioning="true"]')) window.workflowSawMotion=true;}); window.workflowMotionObserver.observe($('.workflow-graph'),{subtree:true,attributes:true}); return true;`,
    );
    await writeSource(WORKFLOW_EDITOR_EXPANDED_SOURCE);
    await wait(
      `return $$('.react-flow__node').some(node=>node.textContent.includes('Check notes')) && $('.workflow-header [role="status"]').textContent.includes('Saved');`,
      "live external edit preview",
    );
    await wait(
      `return !document.querySelector('[data-graph-transitioning="true"]');`,
      "graph transition settled",
    );
    expect(await run(`return window.workflowSawMotion;`)).toBe(true);
    expect(
      await run(
        `return { retainedCanvas: $('.react-flow')===window.workflowCanvas, viewport: $('.react-flow__viewport').style.transform };`,
      ),
    ).toEqual({
      retainedCanvas: true,
      viewport: await run(`return window.workflowViewport;`),
    });
    await run(
      `window.workflowMotionObserver.disconnect(); button('Write summary').click(); return true;`,
    );
    await wait(
      `return $('[data-testid="workflow-details"] h2')?.textContent === 'Write summary';`,
      "selected step details",
    );
    expect(
      await run(`return $('[data-testid="workflow-details"]').innerText;`),
    ).toContain("From");
  });

  it("labels a stale preview and recovers without losing the graph", async () => {
    const count = await run<number>(`return $$('.react-flow__node').length;`);
    await writeSource("export const incomplete =");
    await wait(
      `return $('.workflow-header [role="status"]').textContent.includes('needs attention');`,
      "parse failure status",
    );
    expect(await run(`return $$('.react-flow__node').length;`)).toBe(count);
    expect(await run(`return $('.workflow-notice').innerText;`)).toContain(
      "last valid preview",
    );
    await writeSource(WORKFLOW_EDITOR_EXPANDED_SOURCE);
    await wait(
      `return $('.workflow-header [role="status"]').textContent.includes('Saved');`,
      "preview recovered",
    );
  });

  it("keeps an unsaved buffer across tab changes and asks before discarding", async () => {
    await run(`button('Code').click(); return true;`);
    await wait(
      `return !!$('.workflow-workbench .monaco-editor [role="textbox"]');`,
      "source input",
    );
    await run(
      `await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))); $('.workflow-workbench .monaco-editor [role="textbox"]').focus(); return true;`,
    );
    await app.press("a", process.platform === "darwin" ? 4 : 2);
    await app.insertText(
      WORKFLOW_EDITOR_EXPANDED_SOURCE.replace("Weekly report", "Team report"),
    );
    await wait(
      `return button('Save') && !button('Save').disabled;`,
      "unsaved workflow",
    );
    await wait(
      `return $('.workflow-header h1')?.textContent === 'Team report';`,
      "source edit updates preview",
    );
    await app.waitFor(
      `window.catamorphicDesktop.workspaceStateGet('${projectId}').then(state=>state?.tabs?.some(tab=>tab.workflowDraft?.code.includes('Team report')))`,
      { label: "draft persisted in workspace" },
    );
    await app.reload();
    await wait(
      `return $('.workflow-header h1')?.textContent==='Team report' && !!button('Save') && !button('Save').disabled;`,
      "draft restored after reload",
    );

    await run(
      `window.dispatchEvent(new KeyboardEvent('keydown',{key:'t',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true,cancelable:true})); return true;`,
    );
    await wait(
      `return !!$('textarea[placeholder*="Search or ask"]') && !!$('.workflow-workbench')?.closest('.hidden');`,
      "another tab",
    );
    await run(
      `$('[data-point-key="workflow:linkedWorkflow"] button').click(); return true;`,
    );
    await wait(
      `return button('Save') && !button('Save').disabled;`,
      "draft preserved",
    );
    await run(
      `window.dispatchEvent(new KeyboardEvent('keydown',{key:'w',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true,cancelable:true})); return true;`,
    );
    await wait(
      `return !!$$('[role="dialog"]').find(el=>!el.closest('[inert]')&&el.textContent.includes('Discard workflow edits?'));`,
      "dirty close confirmation",
    );
    await run(
      `$$('button').find(el=>!el.closest('[inert]')&&el.textContent==='Keep editing').click(); return true;`,
    );
    await writeSource(WORKFLOW_EDITOR_SOURCE);
    await wait(
      `return $('.workflow-notice').innerText.includes('changed on disk') && button('Save')?.disabled;`,
      "external conflict preserves draft",
    );
    await run(`button('Use disk version').click(); return true;`);
    await wait(
      `return button('Save')?.disabled && $('.workflow-header h1')?.textContent==='Weekly report';`,
      "explicitly discard local draft",
    );
  });

  it("saves source edits and clears the restored draft", async () => {
    await run(`button('Code').click(); return true;`);
    await wait(
      `return !!$('.monaco-editor [role="textbox"]');`,
      "source editor",
    );
    await run(
      `await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))); $('.monaco-editor [role="textbox"]').focus(); return true;`,
    );
    await app.press("a", process.platform === "darwin" ? 4 : 2);
    await app.insertText(
      WORKFLOW_EDITOR_SOURCE.replace("Weekly report", "Team report"),
    );
    await wait(
      `return button('Save') && !button('Save').disabled && $('.workflow-header h1')?.textContent==='Team report';`,
      "edited workflow ready",
    );
    await run(`button('Save').click(); return true;`);
    await wait(`return !!button('Saved');`, "workflow save completed");
    await app.waitFor(
      `(async()=>{const {url}=await window.catamorphicDesktop.getServerState(); const response=await fetch(url+'/api/projects/${projectId}/files/linked-workflow.ts'); if(!response.ok) throw new Error('Read saved workflow failed ('+response.status+'): '+await response.text()); const file=await response.json(); const state=await window.catamorphicDesktop.workspaceStateGet('${projectId}'); return file.content.includes('Team report') && state?.tabs?.some(tab=>tab.name==='linkedWorkflow'&&!tab.workflowDraft);})()`,
      { label: "source saved and draft cleared" },
    );
  });

  it("does not restore discarded edits when reopening a closed workflow", async () => {
    await run(`button('Code').click(); return true;`);
    await wait(
      `return !!$('.monaco-editor [role="textbox"]');`,
      "source editor",
    );
    await run(
      `await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))); $('.monaco-editor [role="textbox"]').focus(); return true;`,
    );
    await app.press("a", process.platform === "darwin" ? 4 : 2);
    await app.insertText(
      WORKFLOW_EDITOR_SOURCE.replace("Weekly report", "Discarded report"),
    );
    await wait(
      `return $('.workflow-header h1')?.textContent==='Discarded report' && !button('Save')?.disabled;`,
      "draft ready to discard",
    );
    await run(
      `window.dispatchEvent(new KeyboardEvent('keydown',{key:'w',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true,cancelable:true})); return true;`,
    );
    await wait(
      `const discard=$$('button').find(el=>!el.closest('[inert]')&&el.textContent==='Discard and close'); if(discard){discard.click(); return true;} return false;`,
      "discard and close workflow",
    );
    await wait(`return !$('.workflow-workbench');`, "workflow closed");
    await run(
      `window.dispatchEvent(new KeyboardEvent('keydown',{key:'t',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),shiftKey:true,bubbles:true,cancelable:true})); return true;`,
    );
    await wait(
      `return $('.workflow-header h1')?.textContent==='Team report' && button('Save')?.disabled;`,
      "reopened workflow uses saved source",
    );
  });

  it("explains running and offers contextual agent editing", async () => {
    await run(`button('Run').click(); return true;`);
    await wait(`return !!$('[data-testid="workflow-runs"]');`, "run setup");
    expect(
      await run(`return $('[data-testid="workflow-runs"]').innerText;`),
    ).toContain("published project version");
    await wait(
      `return !!button('Record changes in Git') && !button('Record changes in Git').disabled;`,
      "saved files available to record",
    );
    await run(`button('Record changes in Git').click(); return true;`);
    await wait(
      `return !!button('Publish project version') && !button('Publish project version').disabled;`,
      "publishing available",
    );
    await run(`button('Publish project version').click(); return true;`);
    await wait(
      `return [...$('[data-testid="workflow-runs"]').querySelectorAll('label')].some(el=>el.innerText.includes('Topic'));`,
      "published workflow inputs",
    );
    await run(`button('Details').click(); return true;`);
    await run(`button('Describe a change').click(); return true;`);
    await wait(`return !!$('.workflow-field textarea');`, "edit request");
    await run(
      `setReactValue($('.workflow-field textarea'), 'Add an approval before preparing the report'); return true;`,
    );
    await run(`button('Ask agent').click(); return true;`);
    await wait(
      `return $$('[data-chat-local-id]').some(el=>el.textContent.includes('Add an approval before preparing the report'));`,
      "contextual request sent to agent",
    );
    await app.screenshot("/tmp/catamorphic-workflow-authoring.png");
  });
});
