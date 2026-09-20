import { send, evaluate, pause, ws } from '/Users/tabaza/Desktop/work-product-film/activity-demo/cdp.mjs';
const box = (expr) => evaluate(`(() => { const e = ${expr}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
for (let i = 0; i < 6; i += 1) {
  const bubble = await box(`document.querySelector('[data-chat-bubble] button[aria-label^="Open"]')`);
  if (!bubble) break;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...bubble }); await pause(300);
  const close = await box(`document.querySelector('[data-chat-bubble] button[aria-label^="Close"]')`);
  if (!close) { console.log('no close control for bubble', i); break; }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...close }); await pause(120);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...close, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...close, button: 'left', clickCount: 1 });
  await pause(600);
}
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 760, y: 420 }); await pause(400);
console.log(JSON.stringify(await evaluate(`({ bubbles: document.querySelectorAll('[data-chat-bubble]').length, triggers: [...document.querySelectorAll('[data-testid=session-inspector-trigger]')].map(t => t.getAttribute('aria-label')) })`)));
ws.close(); setTimeout(() => process.exit(0), 100);
