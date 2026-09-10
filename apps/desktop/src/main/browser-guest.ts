/** Runs only in the browser driver's isolated world, never the page's world. */
export const BROWSER_GUEST = String.raw`
(() => {
  if (globalThis.catamorphicBrowser) return;
  const generation = crypto.randomUUID();
  let sequence = 0;
  const references = new Map();
  const pointers = new Map();
  let frame = 0;
  const visible = (el) => el.isConnected && el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && !el.closest('[inert]');
  const roots = (root = document) => [root, ...Array.from(root.querySelectorAll('*')).flatMap(el => el.shadowRoot ? roots(el.shadowRoot) : [])];
  const resolve = (uid) => {
    const el = references.get(uid);
    if (!el || !visible(el)) throw Error('Stale or hidden element. Take a fresh browser_snapshot.');
    return el;
  };
  const clear = () => {
    for (const pointer of pointers.values()) pointer.remove();
    pointers.clear();
    observer.disconnect();
    mutations.disconnect();
    removeEventListener('scroll', schedule, true);
    removeEventListener('resize', schedule);
    document.removeEventListener('pointerdown', dismiss, true);
    document.removeEventListener('keydown', dismiss, true);
    cancelAnimationFrame(frame);
    frame = 0;
  };
  const position = () => {
    frame = 0;
    for (const [el, overlay] of pointers) {
      if (!visible(el)) { overlay.remove(); pointers.delete(el); continue; }
      const rect = el.getBoundingClientRect();
      overlay.style.left = rect.left - 3 + 'px';
      overlay.style.top = rect.top - 3 + 'px';
      overlay.style.width = rect.width + 6 + 'px';
      overlay.style.height = rect.height + 6 + 'px';
      const label = overlay.shadowRoot.querySelector('span');
      label.style.top = rect.top > 40 ? 'auto' : 'calc(100% + 8px)';
      label.style.bottom = rect.top > 40 ? 'calc(100% + 8px)' : 'auto';
      label.style.maxWidth = Math.max(80, Math.min(280, innerWidth - Math.max(8, rect.left) - 12)) + 'px';
    }
    if (!pointers.size) clear();
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(position); };
  const observer = new ResizeObserver(schedule);
  const mutations = new MutationObserver(schedule);
  const dismiss = (event) => {
    for (const [el, overlay] of pointers) {
      if (event.composedPath().includes(el)) { overlay.remove(); pointers.delete(el); observer.unobserve(el); }
    }
    if (!pointers.size) clear();
  };
  globalThis.catamorphicBrowser = {
    snapshot() {
      references.clear();
      const elements = roots().flatMap(root => Array.from(root.querySelectorAll('a[href],button,input,textarea,select,summary,[role],h1,h2,h3,label,[contenteditable="true"]'))).filter(visible);
      return {
        url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight },
        elements: elements.slice(0, 300).map(el => {
          const uid = generation + ':' + (++sequence);
          references.set(uid, el);
          const label = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 160);
          return {uid, tag:el.localName, role:el.getAttribute('role'), label,
            disabled:el.matches(':disabled,[aria-disabled="true"]'),
            ...(el instanceof HTMLSelectElement ? {options:Array.from(el.options).map(o => ({value:o.value,label:o.label,selected:o.selected}))} : {}),
            ...(el instanceof HTMLInputElement && el.type !== 'password' ? {value:el.value,checked:el.checked} : {}),
          };
        }),
        truncated:elements.length > 300,
        frames: Array.from(document.querySelectorAll('iframe')).map(el => ({title:el.title,src:el.src})),
        note: 'Element references cover this document and open shadow roots. Use an image snapshot and coordinates for embedded frames or canvas.',
      };
    },
    viewport() { return {width:innerWidth,height:innerHeight}; },
    generation() { return generation; },
    prepare(uid, editing = false) {
      const el = resolve(uid);
      if (el.matches(':disabled,[aria-disabled="true"]') || (editing && el.readOnly)) throw Error('Element is disabled or read-only.');
      el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
      const rect = el.getBoundingClientRect();
      const x = Math.max(0,rect.left) + (Math.min(innerWidth,rect.right)-Math.max(0,rect.left))/2;
      const y = Math.max(0,rect.top) + (Math.min(innerHeight,rect.bottom)-Math.max(0,rect.top))/2;
      const hit = el.getRootNode().elementFromPoint(x,y);
      if (!hit || !(el === hit || el.contains(hit))) throw Error('Element is covered. Take a fresh snapshot before acting.');
      if (editing) {
        if (!(el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && /^(text|search|email|url|tel|password|number)$/.test(el.type)) || el.isContentEditable)) throw Error('fill requires a text input or contenteditable. Use select for a dropdown.');
        el.focus({preventScroll:true});
        if (el.isContentEditable) {
          const range = document.createRange(); range.selectNodeContents(el);
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        } else if (el.type !== 'number') el.select();
      }
      return {x,y};
    },
    select(uid, value) {
      const el = resolve(uid);
      if (!(el instanceof HTMLSelectElement) || el.disabled) throw Error('select requires an enabled select element.');
      const option = Array.from(el.options).find(o => o.value === value);
      if (!option || option.disabled || option.parentElement.disabled) throw Error('No enabled option with that value.');
      el.value = value;
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      return {ok:true,value:el.value};
    },
    point(uid, note, keepPrevious) {
      const el = resolve(uid);
      if (!keepPrevious) clear();
      el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
      pointers.get(el)?.remove();
      const overlay = document.createElement('div');
      overlay.dataset.catamorphicPointer = '';
      overlay.setAttribute('aria-hidden','true');
      overlay.style.cssText = 'all:initial;position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;border:2px solid #f95225;border-radius:6px;box-shadow:0 0 0 4px #f9522533;';
      const shadow = overlay.attachShadow({mode:'open'});
      const label = document.createElement('span');
      label.textContent = note || '';
      label.style.cssText = 'position:absolute;left:0;padding:6px 10px;border-radius:7px;background:#202024;color:#fff;font:500 12px/1.4 system-ui;box-shadow:0 3px 14px #0003;overflow-wrap:anywhere;box-sizing:border-box;';
      label.hidden = !note;
      shadow.append(label);
      document.documentElement.append(overlay);
      pointers.set(el,overlay);
      observer.observe(el);
      observer.observe(document.documentElement);
      mutations.observe(document.documentElement,{subtree:true,childList:true});
      addEventListener('scroll',schedule,true);
      addEventListener('resize',schedule);
      document.addEventListener('pointerdown',dismiss,true);
      document.addEventListener('keydown',dismiss,true);
      position();
      return {ok:true};
    },
    clear,
    read() {return {url:location.href,title:document.title,text:(document.body?.innerText || '').slice(0,30000)};},
  };
})();
`;
