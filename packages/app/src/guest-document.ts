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
  /** Tenant-policy network origins the guest CSP may allow. */
  allowedNetworkOrigins?: string[];
}): string {
  const csp = appGuestCsp(args.allowedNetworkOrigins);
  // The host runtime, one inline script ahead of the bundle:
  // - `process` shim: Vite lib-mode builds keep `process.env.NODE_ENV`
  //   verbatim (lib mode never injects the define) and the guest frame has
  //   no Node globals, so an unshimmed bundle would throw before mounting.
  // - auto-height: most apps never call reportHeight(); observe the
  //   document and post the same resize message the client library would.
  //   scrollHeight is max(content, viewport), so it ratchets up to the
  //   content height and settles; the host clamps either way.
  // - live theme: apply `theme` messages as `--color-*` custom properties,
  //   the same vars the initial <style> below seeds.
  const runtime =
    'var process={env:{NODE_ENV:"production"}};' +
    "addEventListener('load',()=>{const post=()=>parent.postMessage(" +
    `{catamorphicApp:${APP_PROTOCOL_VERSION},kind:'resize',height:document.documentElement.scrollHeight},'*');` +
    "post();const o=new ResizeObserver(post);o.observe(document.documentElement);o.observe(document.body)});" +
    "addEventListener('message',(e)=>{const d=e.data;" +
    `if(!d||d.catamorphicApp!==${APP_PROTOCOL_VERSION}||d.kind!=='theme')return;` +
    "const r=document.documentElement;" +
    "for(const[k,v]of Object.entries(d.theme.colors))r.style.setProperty('--color-'+k,String(v));" +
    "r.style.colorScheme=d.theme.appearance});";
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    // Theme + shared base first, the app's own CSS last so it can override.
    ...(args.theme
      ? [`<style>${escapeStyleContent(appThemeCss(args.theme))}</style>`]
      : []),
    `<style>${APP_BASE_CSS}</style>`,
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
