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
 const hover = el => el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,relatedTarget:document.body}));
 const paste = text => { const c=composer(); c.focus(); const range=document.createRange(); range.selectNodeContents(c); range.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(range); const data=new DataTransfer(); data.setData('text/plain',text); c.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true})); };
`;
const run = <T = unknown>(body: string) =>
  app.eval<T>(`(()=>{${js}\n${body}})()`);
const wait = (body: string) => app.waitFor(`(()=>{${js}\n${body}})()`);
async function clear() {
  if (await run("return !!preview();")) await app.press("Escape");
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
  await app.eval("location.reload()");
  await app.waitFor(`document.body?.innerText.includes('Preview project')`);
  await app.eval(`window.catamorphicDesktop.devWindow('setSize',1100,800)`);
  await app.eval(
    `window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true}))`,
  );
  await wait(`return !!front();`);
  const video = await app.eval<string>(`new Promise(resolve => {
    const canvas=document.createElement('canvas'); canvas.width=160; canvas.height=90;
    const context=canvas.getContext('2d'); context.fillStyle='#647cff'; context.fillRect(0,0,160,90);
    const stream=canvas.captureStream(10); const recorder=new MediaRecorder(stream,{mimeType:'video/webm'}); const chunks=[];
    recorder.ondataavailable=event=>chunks.push(event.data);
    recorder.onstop=async()=>{ stream.getTracks().forEach(track=>track.stop()); const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer()); resolve(btoa(String.fromCharCode(...bytes))); };
    recorder.start(); const ticker=setInterval(()=>context.fillRect(0,0,160,90),50); setTimeout(()=>{clearInterval(ticker);recorder.stop();},600);
  })`);
  fs.writeFileSync(path.join(root, "clip.webm"), Buffer.from(video, "base64"));
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
it("clamps the preview to a compact viewport and dismisses on outside interaction", async () => {
  await app.eval(`window.catamorphicDesktop.devWindow('setSize',720,600)`);
  await app.waitFor(`innerWidth<=720 && innerHeight<=600`);
  await app.eval(
    `document.querySelector('[aria-label="Collapse sidebar"]')?.click(); document.querySelector('[aria-label="Collapse right sidebar"]')?.click()`,
  );
  await inspect("picture.svg");
  await wait(`return preview()?.querySelector('img')?.naturalWidth===360;`);
  expect(
    await run(
      `const r=preview().getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight;`,
    ),
  ).toBe(true);
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
