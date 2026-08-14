import { APP_KIT_CSS } from "./kit-css.js";
import { APP_PROTOCOL_VERSION } from "./protocol.js";
import { APP_BASE_CSS, type AppHostTheme, appThemeCss } from "./theme.js";

/**
 * The guest document for a mounted app, served to a sandboxed iframe (or an
 * MCP Apps host). One definition for every surface that embeds a bundle:
 * default-deny CSP, the host theme + shared base layer, the version's CSS,
 * one root node, a small host runtime, and the bundle.
 *
 * The document must always be delivered from a real URL (or an MCP
 * resource), never `srcdoc`: local-scheme documents inherit the embedding
 * page's Content-Security-Policy, and a host shell with a strict
 * `script-src` (no `unsafe-inline`) would silently block the bundle.
 */
export function buildAppGuestDocument(args: {
  code: string;
  css: string;
  theme?: AppHostTheme;
  /**
   * An embedder stylesheet, injected AFTER the kit CSS and BEFORE the app's
   * own CSS: the host can restyle or extend the `cat-*` classes wholesale
   * (and the app can still override anything). Escaped like the app CSS.
   */
  hostCss?: string;
  /**
   * `false` omits the kit stylesheet entirely, for embedders that want the
   * kit's structure and behavior with none of its styling. Default: injected.
   */
  kit?: boolean;
  /** Tenant-policy network origins the guest CSP may allow. */
  allowedNetworkOrigins?: string[];
  /**
   * The caller's persisted localStorage snapshot, baked into the shim so
   * synchronous reads work from the first line of app code. Flat string
   * map; anything else is ignored by the runtime.
   */
  storageSeed?: Record<string, string>;
}): string {
  const csp = appGuestCsp(args.allowedNetworkOrigins);
  // The host runtime, one inline script ahead of the bundle:
  // - `process` shim: Vite lib-mode builds keep `process.env.NODE_ENV`
  //   verbatim (lib mode never injects the define) and the guest frame has
  //   no Node globals, so an unshimmed bundle would throw before mounting.
  // - storage shim: the sandbox withholds `allow-same-origin`, so the guest
  //   has an opaque origin and merely READING `window.localStorage` throws a
  //   SecurityError. Agent-built apps reach for localStorage constantly, and
  //   one uncaught access (a save effect, say) tears the whole React tree
  //   down to a blank page. Shadow both storages with in-memory Storage
  //   stand-ins — and make localStorage DURABLE: it hydrates from the
  //   caller's persisted snapshot (baked in at serve time, so synchronous
  //   reads work immediately) and mutations post a debounced full-snapshot
  //   `storage` message the mount persists per (app, user). sessionStorage
  //   stays memory-only, matching its name.
  // - auto-height: most apps never call reportHeight(); observe the
  //   document and post the same resize message the client library would.
  //   scrollHeight is max(content, viewport), so it ratchets up to the
  //   content height and settles; the host clamps either way.
  // - live theme: apply `theme` messages as custom properties — colors AND
  //   the feel tokens (fonts, radii, easing, sizes, motion) — the same vars
  //   the initial <style> below seeds.
  const runtime =
    'var process={env:{NODE_ENV:"production"}};' +
    `(()=>{const seed=${safeJsonForScript(args.storageSeed ?? {})};` +
    "const store=(init,persist)=>{" +
    "const m=new Map();for(const[k,v]of Object.entries(init))if(typeof v==='string')m.set(k,v);" +
    "let t;const flush=()=>{t=undefined;const data={};for(const[k,v]of m)data[k]=v;" +
    `parent.postMessage({catamorphicApp:${APP_PROTOCOL_VERSION},kind:'storage',data},'*')};` +
    "const queue=persist?()=>{clearTimeout(t);t=setTimeout(flush,250)}:()=>{};" +
    "if(persist)addEventListener('pagehide',()=>{if(t!==undefined){clearTimeout(t);flush()}});" +
    "return{getItem:(k)=>m.has(String(k))?m.get(String(k)):null," +
    "setItem:(k,v)=>{m.set(String(k),String(v));queue()}," +
    "removeItem:(k)=>{m.delete(String(k));queue()}," +
    "clear:()=>{m.clear();queue()}," +
    "key:(i)=>[...m.keys()][i]??null," +
    "get length(){return m.size}}};" +
    "for(const[name,persist]of[['localStorage',true],['sessionStorage',false]]){" +
    "try{void window[name]}catch{" +
    "Object.defineProperty(window,name,{value:store(persist?seed:{},persist),configurable:true})}}})();" +
    "addEventListener('load',()=>{const post=()=>parent.postMessage(" +
    `{catamorphicApp:${APP_PROTOCOL_VERSION},kind:'resize',height:document.documentElement.scrollHeight},'*');` +
    "post();const o=new ResizeObserver(post);o.observe(document.documentElement);o.observe(document.body)});" +
    "addEventListener('message',(e)=>{const d=e.data;" +
    `if(!d||d.catamorphicApp!==${APP_PROTOCOL_VERSION}||d.kind!=='theme')return;` +
    "const t=d.theme,r=document.documentElement;" +
    "for(const[k,v]of Object.entries(t.colors))r.style.setProperty('--color-'+k,String(v));" +
    // Feel tokens, mirroring appThemeVars: [property, group key, leaf key]
    // (a null group reads the leaf off the theme itself).
    "const F=[['--font-sans','fonts','sans'],['--font-mono','fonts','mono']," +
    "['--radius-sm','radii','sm'],['--radius-md','radii','md'],['--radius-lg','radii','lg']," +
    "['--ease-standard',null,'easing'],['--cat-font-size',null,'baseFontSize']," +
    "['--cat-row-h',null,'rowHeight'],['--cat-motion-fast','motion','fast']," +
    "['--cat-motion-base','motion','base'],['--cat-motion-slow','motion','slow']];" +
    "for(const[p,g,k]of F){const o=g?t[g]:t;const v=o&&typeof o==='object'?o[k]:undefined;" +
    "if(typeof v==='string')r.style.setProperty(p,v)}" +
    "r.style.colorScheme=t.appearance});";
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    // Style order is the override order: neutral base defaults, then the
    // host theme (which overrides any base token), then the UI-kit classes
    // (consuming the tokens; omitted when the embedder opts out), then the
    // embedder's own stylesheet, the app's CSS last so it can override
    // anything.
    `<style>${APP_BASE_CSS}</style>`,
    ...(args.theme
      ? [`<style>${escapeStyleContent(appThemeCss(args.theme))}</style>`]
      : []),
    ...(args.kit === false ? [] : [`<style>${APP_KIT_CSS}</style>`]),
    ...(args.hostCss !== undefined
      ? [`<style>${escapeStyleContent(args.hostCss)}</style>`]
      : []),
    `<style>${escapeStyleContent(args.css)}</style>`,
    "</head><body>",
    '<div id="root"></div>',
    `<script>${runtime}</script>`,
    `<script>${escapeScriptContent(args.code)}</script>`,
    "</body></html>",
  ].join("");
}

/**
 * The guest CSP: default-deny network; the tenant's app policy may open
 * specific https origins (`tenant_app_policies.allowed_network_origins`) —
 * validated as plain https origins at write time, so they are CSP-safe
 * verbatim. Sent both as the serving route's response header and as the
 * document's own meta tag, so the policy holds wherever the doc lands.
 */
export function appGuestCsp(allowedNetworkOrigins?: string[]): string {
  const connectSrc =
    allowedNetworkOrigins && allowedNetworkOrigins.length > 0
      ? `connect-src ${allowedNetworkOrigins.join(" ")}`
      : "connect-src 'none'";
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    connectSrc,
  ].join("; ");
}

/**
 * A literal `</script` inside the bundle — a string constant is enough —
 * would terminate the inline script early and dump the rest of the bundle
 * into the document as markup. `<\/` is identical to the JS parser (in
 * strings, template literals, and regex alike) but invisible to the HTML
 * tokenizer.
 *
 * `<!--` is deliberately NOT rewritten: it is valid JS outside a string
 * (`a<!--b` parses as `a < !(--b)`, which minifiers emit), and `\x3C` is only
 * an escape *inside* a string literal, so blind replacement turns a working
 * bundle into a SyntaxError. It cannot break out of the script element on its
 * own — only `</script` can.
 */
function escapeScriptContent(code: string): string {
  return code.replaceAll(/<\/(script)/gi, "<\\/$1");
}

/** `</style` in CSS content would end the style block and inject markup. */
function escapeStyleContent(css: string): string {
  return css.replaceAll(/<\/(style)/gi, "<\\/$1");
}

/**
 * JSON destined for an inline <script>. The seed holds user data, so a
 * value containing `</script` (or an HTML comment opener) must not reach
 * the HTML tokenizer, and U+2028/9 are line terminators to JS but not to
 * JSON — all four get unicode-escaped, which JSON.parse-compatible JS
 * string semantics read back identically.
 */
function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
