import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, focusWindow, launchApp } from "./harness.js";

let app: AppHandle;
const api = "window.catamorphicDesktop";
const mic = "document.querySelector('[data-testid=\"voice-button\"]')";
const utterance = "This is a held message.";

beforeAll(async () => {
  app = await launchApp({
    env: { CATAMORPHIC_E2E_FAKE_VOICE: JSON.stringify([utterance]) },
  });
  const project = await app.eval<{ id: string }>(
    `${api}.createProject(${JSON.stringify({ name: "Voice clicks", rootPath: path.join(app.userDataDir, "voice-clicks") })})`,
  );
  await app.eval(
    `${api}.workspaceNavigate({projectId:${JSON.stringify(project.id)}})`,
  );
  await app.waitFor(
    `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime===${JSON.stringify(project.id)}`,
  );
  await app.waitFor(`!!${mic}`);
  await app.eval(`${api}.setKeybindings({'talk-to-work':'Cmd+Shift+V'})`);
  await focusWindow(app);
});

afterAll(async () => {
  try {
    expect(app?.getRendererErrors() ?? []).toEqual([]);
  } finally {
    await app?.stop();
  }
});

async function point() {
  await focusWindow(app);
  const value = await app.waitFor<{ x: number; y: number }>(
    `(()=>{
    const button=${mic};
    if(!button?.checkVisibility({opacityProperty:true,visibilityProperty:true}))return false;
    const rail=button.closest('[data-dock-rail]');
    if(rail?.getAnimations({subtree:true}).some(a=>(a.playState==='running'||a.pending)&&a.effect?.getTiming().iterations!==Infinity))return false;
    const box=button.getBoundingClientRect(),point={x:box.x+box.width/2,y:box.y+box.height/2};
    return button.contains(document.elementFromPoint(point.x,point.y))&&point;
  })()`,
    { label: "the settled microphone hit target" },
  );
  await app.movePointer(value);
  return value;
}

async function recordPhases() {
  await app.eval(`(()=>{
    window.__clickPhases=[];
    window.__clickOff?.();
    window.__clickOff=${api}.onVoiceStatus(status=>window.__clickPhases.push(status.phase));
    return true;
  })()`);
}

async function messageCount() {
  return app.eval<number>(`(async()=>{
    const ref=(await ${api}.getPrefs()).assistantSession;
    if(!ref)return 0;
    const {url}=await ${api}.getServerState();
    const detail=await fetch(url+'/api/projects/'+ref.projectId+'/agent/sessions/'+ref.sessionId).then(r=>r.json());
    return detail.snapshot.items.filter(item=>item.kind==='user_message').length;
  })()`);
}

async function click() {
  const target = await point();
  await recordPhases();
  for (const type of ["mousePressed", "mouseReleased"])
    await app.cdp("Input.dispatchMouseEvent", {
      type,
      ...target,
      button: "left",
      clickCount: 1,
    });
  await app.waitFor(`${api}.voiceStatus().then(status=>status.phase==='off')`, {
    label: "a short click cancelled",
  });
  const tooltip = await app.waitFor<string>(
    `[...document.querySelectorAll('[role="tooltip"]')].find(t=>t.textContent.includes('Press and hold to speak')&&getComputedStyle(t).opacity==='1')?.textContent`,
    { label: "the hold instruction after a click" },
  );
  expect(tooltip).toContain(
    process.platform === "darwin" ? "⌘⇧V" : "Ctrl+Shift+V",
  );
  expect(await app.eval<string[]>("window.__clickPhases")).not.toContain(
    "thinking",
  );
  expect(await app.eval<string[]>("window.__clickPhases")).not.toContain(
    "speaking",
  );
  expect(await app.eval(`${mic}.hasAttribute('data-lit')`)).toBe(false);
}

it("teaches a cold short click without submitting a message", async () => {
  await click();
  expect(await messageCount()).toBe(0);
});

it("still captures and sends the next held message", async () => {
  const audio = await app.connectToFrame("voice.html");
  try {
    await audio.eval(`(()=>{
      window.__clickSeconds=0;
      const post=MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage=function(value,...args){
        if(value?.type==='frame')window.__clickSeconds+=value.samples.length/value.sampleRate;
        return Reflect.apply(post,this,[value,...args]);
      };
      return true;
    })()`);
    const target = await point();
    await recordPhases();
    await app.cdp("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...target,
      button: "left",
      clickCount: 1,
    });
    await app.waitFor(
      `${api}.voiceStatus().then(status=>status.phase==='hearing')`,
    );
    await audio.waitFor("window.__clickSeconds>=1.7", {
      label: "the held phrase captured",
    });
    await app.cdp("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...target,
      button: "left",
      clickCount: 1,
    });
    await app.waitFor(
      "window.__clickPhases.includes('speaking')&&window.__clickPhases.at(-1)==='off'",
      {
        timeoutMs: 30000,
        label: "the held message answered and voice settled",
      },
    );
    expect(await messageCount()).toBe(1);
  } finally {
    audio.close();
  }
});

it("teaches repeated warm clicks without another turn, and Escape dismisses the hint", async () => {
  for (let count = 0; count < 2; count++) {
    await click();
    expect(await messageCount()).toBe(1);
    await app.press("Escape");
    await app.waitFor(
      `![...document.querySelectorAll('[role="tooltip"]')].some(t=>t.textContent.includes('Press and hold to speak')&&getComputedStyle(t).opacity==='1')`,
      { label: "the click hint dismissed" },
    );
  }
});
