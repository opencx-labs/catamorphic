import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

let app: AppHandle;
let root: string;
const js = `
 const front = () => [...document.querySelectorAll('section[aria-label]')].find(e=>!e.closest('[inert]') && e.querySelector('[data-composer-input]'));
 const composer = () => front().querySelector('[data-composer-input]');
 const pill = () => front().querySelector('[data-testid="composer-pill"]');
 const preview = () => document.querySelector('[data-resource-inspector][data-open="true"]');
 const hover = el => el.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,relatedTarget:document.body}));
 const paste = text => { const c=composer(); c.focus(); const range=document.createRange(); range.selectNodeContents(c); range.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(range); const data=new DataTransfer(); data.setData('text/plain',text); c.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true})); };
`;
const run = <T = unknown>(body: string) =>
  app.eval<T>(`(()=>{${js}\n${body}})()`);
const wait = (body: string) => app.waitFor(`(()=>{${js}\n${body}})()`);
async function clear() {
  if (await run("return !!preview();")) await app.press("Escape");
  // Sidebar and outside interactions can park the floating chat. Restore it
  // before the next preview scenario edits the shared composer.
  await run(`
    if (!front()) window.dispatchEvent(new KeyboardEvent('keydown', {
      key:'m',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true,cancelable:true
    }));
  `);
  await wait(`return !!front();`);
  await run(
    `composer().replaceChildren(); composer().dispatchEvent(new InputEvent('input',{bubbles:true}));`,
  );
  await wait(`return !pill() && !preview();`);
}
async function inspect(name: string) {
  await clear();
  await run(`paste(${JSON.stringify(path.join(root, name))});`);
  await wait(`return !!pill();`);
  // Finish layout motion and scrolling before hovering. A resize can scroll
  // the compact composer after a synthetic mouseover and dismiss its preview.
  await run(`
    pill().scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
    return Promise.all(front().getAnimations({subtree:true})
      .filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity)
      .map(animation=>animation.finished.catch(()=>{})));
  `);
  await app.eval(
    `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`,
  );
  await run(`hover(pill());`);
  await wait(
    `return !!preview()?.querySelector('[data-resource-preview-kind]');`,
  );
}
beforeAll(async () => {
  app = await launchApp();
  await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
  root = path.join(app.userDataDir, "preview-project");
  await app.eval(
    `window.catamorphicDesktop.createProject({name:'Preview project',rootPath:${JSON.stringify(root)}})`,
  );
  fs.writeFileSync(
    path.join(root, "picture.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="220"><rect width="360" height="220" fill="#647cff"/><circle cx="180" cy="110" r="70" fill="#ffbd69"/></svg>',
  );
  fs.writeFileSync(
    path.join(root, "notes.html"),
    "<script>window.previewExecuted=true</script>\nPreview plain text",
  );
  fs.writeFileSync(
    path.join(root, "notes.md"),
    "# Project notes\n\n**Ready** for review.\n\n- First\n- Second\n\n| Name | State |\n| --- | --- |\n| Build | Done |\n",
  );
  fs.writeFileSync(
    path.join(root, "archive.zip"),
    Buffer.from([80, 75, 0, 255]),
  );
  fs.writeFileSync(path.join(root, "broken.png"), "corrupt image");
  const wav = Buffer.alloc(44 + 16000);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(16000, 40);
  fs.writeFileSync(path.join(root, "sound.wav"), wav);
  await app.reload();
  await app.waitFor(`document.body?.innerText.includes('Preview project')`);
  await app.eval(`window.catamorphicDesktop.devWindow('setSize',1100,800)`);
  await app.eval(
    `window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true}))`,
  );
  await wait(`return !!front();`);
  // Use a fixed VP8 clip. Recording a canvas for 600 ms can produce an empty
  // stream when a busy compositor does not deliver frames before the timer.
  fs.copyFileSync(
    new URL("./fixtures/resource-preview.webm", import.meta.url),
    path.join(root, "clip.webm"),
  );
});
afterAll(async () => {
  await app?.stop();
});
it("previews path images in composer and sent user messages", async () => {
  await inspect("picture.svg");
  await wait(`return preview()?.querySelector('img')?.naturalWidth===360;`);
  expect(await run(`return preview().textContent;`)).toContain(
    path.join(root, "picture.svg"),
  );
  const trigger = await run<{ x: number; y: number }>(
    `const r=pill().getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};`,
  );
  await app.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...trigger });
  const card = await run<{ x: number; y: number }>(
    `const r=preview().getBoundingClientRect(); return {x:r.left+20,y:r.top+20};`,
  );
  await app.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...card });
  expect(
    await app.eval(
      `new Promise(resolve=>setTimeout(()=>resolve(!!document.querySelector('[data-resource-inspector][data-open="true"]')),350))`,
    ),
  ).toBe(true);
  await app.screenshot("/tmp/resource-preview-composer.png");
  await app.press("Escape");
  await wait(`return !preview();`);
  await run(
    `composer().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));`,
  );
  await wait(
    `return !!front().querySelector('[data-user-message] [data-testid="sent-pill"]') && !pill();`,
  );
  await run(
    `hover(front().querySelector('[data-user-message] [data-testid="sent-pill"]'));`,
  );
  await wait(`return preview()?.querySelector('img')?.naturalWidth===360;`);
  await app.screenshot("/tmp/resource-preview-sent.png");
});
it("renders text safely, reports corrupt/binary/missing files, and retries", async () => {
  await inspect("notes.html");
  expect(
    await run(`return preview().querySelector('pre').textContent;`),
  ).toContain("<script>");
  expect(await run(`return !!window.previewExecuted;`)).toBe(false);
  await inspect("archive.zip");
  expect(await run(`return preview().textContent;`)).toContain(
    "No inline preview",
  );
  await inspect("broken.png");
  await wait(
    `return preview()?.textContent.includes('could not be previewed');`,
  );
  await inspect("missing.txt");
  expect(await run(`return preview().textContent;`)).toContain(
    "missing or cannot be read",
  );
  fs.writeFileSync(path.join(root, "missing.txt"), "Recovered content");
  await run(`preview().querySelector('button').click();`);
  await wait(
    `return preview()?.querySelector('pre')?.textContent==='Recovered content';`,
  );
});
it("keeps audio controls usable and stops playback when dismissed", async () => {
  await inspect("sound.wav");
  await wait(`return preview()?.querySelector('audio')?.readyState>=1;`);
  await run(
    `window.previewMedia=preview().querySelector('audio'); window.previewMedia.focus(); return window.previewMedia.play();`,
  );
  await wait(`return !window.previewMedia.paused && !!preview();`);
  await app.press("Escape");
  await wait(`return window.previewMedia.paused && !preview();`);
});
it("plays video without autoplay and preserves document metadata", async () => {
  await inspect("clip.webm");
  await wait(`return preview()?.querySelector('video')?.readyState>=2;`);
  expect(await run(`return preview().querySelector('video').paused;`)).toBe(
    true,
  );
  await run(
    `window.previewVideo=preview().querySelector('video'); return window.previewVideo.play();`,
  );
  await wait(`return window.previewVideo.currentTime>0;`);
  await run(`window.previewVideo.pause();`);
  await app.screenshot("/tmp/resource-preview-video.png");
  const result = await app.eval<{
    name: string;
    location?: string;
    content: { kind: string };
  }>(
    `window.catamorphicDesktop.filePreview({document:{name:'..',mediaType:'application/octet-stream',dataBase64:btoa('safe content')}})`,
  );
  expect(result.name).toBe("..");
  expect(result.location).toBeUndefined();
  expect(result.content.kind).toBe("text");
});
it("renders Markdown in composer previews", async () => {
  await inspect("notes.md");
  await wait(
    `return preview()?.querySelector('h1')?.textContent === 'Project notes';`,
  );
  expect(await run(`return preview().querySelectorAll('li').length;`)).toBe(2);
  expect(
    await run(`return preview().querySelector('strong')?.textContent;`),
  ).toBe("Ready");
  await wait(`return getComputedStyle(preview()).opacity === "1";`);
  await app.screenshot("/tmp/resource-preview-markdown-composer.png");
});
it("gives AI file references pills and web links inline cards, resolving project paths", async () => {
  await clear();
  await run(
    `paste('artifact links'); composer().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));`,
  );
  await wait(`return !!front().querySelector('[data-response-link="file"]');`);
  expect(
    await run(
      `return front().querySelector('[data-response-link="workflow"]')?.textContent;`,
    ),
  ).toContain("Workflow");
  expect(
    await run(
      `return front().querySelector('[data-response-link="app"]')?.textContent;`,
    ),
  ).toContain("App");
  await run(`front().querySelector('a[href="file:linked-notes.md"]').focus();`);
  await wait(
    `return preview()?.querySelector('h1')?.textContent === 'Linked notes';`,
  );
  await app.screenshot("/tmp/resource-preview-markdown-response.png");
  await app.press("Escape");
  await wait(`return !preview();`);
  await run(
    `front().querySelector('a[href="file:linked-source.ts:3"]').focus();`,
  );
  await wait(
    `return preview()?.querySelector('pre')?.textContent.includes('export const second');`,
  );
  await app.screenshot("/tmp/resource-preview-ai-code.png");
  await app.press("Escape");
  await wait(`return !preview();`);
  await run(`front().querySelector('a[href="file:artifact.pdf"]').focus();`);
  await wait(
    `return preview()?.querySelector('[data-preview-location]')?.textContent.endsWith('/artifact.pdf');`,
  );
  expect(
    await run(
      `return preview().querySelector('[data-resource-preview-kind]').dataset.resourcePreviewKind;`,
    ),
  ).toBe(
    process.platform === "darwin" || process.platform === "win32"
      ? "image"
      : "unavailable",
  );
  await app.screenshot("/tmp/resource-preview-pdf.png");

  await app.press("Escape");
  await wait(`return !preview();`);
  await run(
    `composer().focus(); document.execCommand('insertText',false,'[A reference](https://example.com/preview-test)'); composer().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));`,
  );
  await wait(`return !!front().querySelector('[data-response-link="web"]');`);
  await run(`front().querySelector('[data-response-link="web"]').focus();`);
  await wait(
    `return preview()?.textContent.includes('https://example.com/preview-test');`,
  );
  expect(
    await run(
      `return front().querySelector('[data-response-link="web"]').classList.contains('inline-flex');`,
    ),
  ).toBe(false);
  await app.eval(
    `window.catamorphicDesktop.setTheme({selection:'light',overrides:{}})`,
  );
  await app.screenshot("/tmp/resource-preview-web-light.png");
});
it("previews recent terminal output from the composer rail", async () => {
  await clear();
  await run(
    `paste('terminal: echo preview-terminal-output'); composer().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));`,
  );
  await wait(
    `const button = front().querySelector('[data-testid="surface-chip"][data-kind="terminal"] button'); return button && !button.closest("[inert]") && front().textContent.includes("terminal result:");`,
  );
  await run(
    `front().querySelector('[data-testid="surface-chip"][data-kind="terminal"] button').focus();`,
  );
  await wait(
    `return preview()?.querySelector('pre')?.textContent.includes('preview-terminal-output');`,
  );
  await wait(`return getComputedStyle(preview()).opacity === "1";`);
  await app.screenshot("/tmp/resource-preview-terminal.png");
  await app.press("Escape");
  await run(
    `front().querySelector('[data-response-link="terminal"]').focus();`,
  );
  await wait(
    `return preview()?.querySelector('pre')?.textContent.includes('preview-terminal-output');`,
  );
  await app.press("Escape");
});
it("expands a plural group into every member without clipping the list", async () => {
  for (const marker of ["second", "third", "fourth"]) {
    await clear();
    await run(
      `paste('terminal: echo preview-group-${marker}'); composer().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));`,
    );
    await wait(
      `return [...front().querySelectorAll('[role="log"] article')].some(el => el.textContent.includes('terminal result:') && el.textContent.includes('preview-group-${marker}'));`,
    );
  }
  await wait(
    `const button = front().querySelector('[data-testid="surface-group"][data-kind="terminal"]'); return button && !button.closest('[inert]');`,
  );
  expect(
    await run(
      `return front().querySelector('[data-testid="surface-group"][data-kind="terminal"]').textContent;`,
    ),
  ).toBe("Terminals4");
  await run(
    `front().querySelector('[data-testid="surface-group"][data-kind="terminal"]').click();`,
  );
  await wait(
    `const panel = front().querySelector('[data-testid="surface-group-members"]'); if (!panel || panel.children.length !== 4) return false; const button = panel.querySelector('button'); const rect = button.getBoundingClientRect(); return button.contains(document.elementFromPoint(rect.left + 10, rect.top + rect.height / 2));`,
  );
  const memberLabels = await run<string[]>(
    `return [...front().querySelectorAll('[data-testid="surface-group-members"] > div')].map(row => row.querySelector('button')?.textContent);`,
  );
  expect(new Set(memberLabels).size).toBe(4);
  await app.screenshot("/tmp/resource-preview-group.png");
  await run(
    `front().querySelector('[data-testid="surface-group-members"] button').focus();`,
  );
  // The stationary pointer can hover a different member as the group expands.
  // Assert the focused member's own preview, identified by its ARIA relationship.
  await wait(
    `const panel = document.getElementById(document.activeElement?.getAttribute('aria-details') ?? ''); return panel?.querySelector('pre')?.textContent.includes('preview-terminal-output');`,
  );
  await app.press("Escape");
  await run(
    `front().querySelector('[data-testid="surface-group"][data-kind="terminal"]').click();`,
  );
});
it("clamps the preview to a compact viewport and dismisses on outside interaction", async () => {
  await app.eval(`window.catamorphicDesktop.devWindow('setSize',720,600)`);
  await app.waitFor(`innerWidth<=720 && innerHeight<=600`);
  await app.eval(
    `document.querySelector('[aria-label="Collapse sidebar"]')?.click(); document.querySelector('[aria-label="Collapse right sidebar"]')?.click()`,
  );
  await inspect("picture.svg");
  await wait(`return preview()?.querySelector('img')?.naturalWidth===360;`);
  await wait(
    `if (!preview()) return false; const r=preview().getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight;`,
  );
  await app.screenshot("/tmp/resource-preview-compact-light.png");
  await run(
    `document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));`,
  );
  await wait(`return !preview();`);
});

it("opens a workflow resource pill as a graph", async () => {
  await clear();
  await run(
    `front().querySelector('[data-response-link="workflow"]').click();`,
  );
  await wait(
    `return !!document.querySelector('.workflow-workbench .react-flow__node');`,
  );
  expect(
    await run(
      `return !!document.querySelector('.workflow-workbench .monaco-editor');`,
    ),
  ).toBe(false);
});
