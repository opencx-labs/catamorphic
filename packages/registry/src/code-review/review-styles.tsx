const css = `
.cat-review,.cat-review-nav,.cat-review-finding,.cat-review-diff{--review-space:calc(var(--cat-row-h,28px)/7);--review-font-small:calc(var(--cat-font-size,13px) - 1px);--review-font-caption:calc(var(--cat-font-size,13px) - 2px);--review-font-heading:calc(var(--cat-font-size,13px) + 3px)}
html:has(.cat-review),body:has(.cat-review),#root:has(>.cat-review){height:100%}
.cat-review{display:flex;flex-direction:column;min-height:0;height:100%;min-width:0;color:var(--color-fg);background:var(--color-bg);font:var(--cat-font-size,13px)/1.5 var(--font-sans,system-ui)}
.cat-review-heading{display:flex;align-items:center;gap:calc(var(--review-space)*3);padding:calc(var(--review-space)*3) calc(var(--review-space)*4);border-bottom:1px solid var(--color-border)}
.cat-review-heading h1{font-size:var(--review-font-heading);font-weight:600;margin:0}.cat-review-heading p{margin:2px 0 0;color:var(--color-fg-muted);font-size:var(--review-font-small)}
.cat-review-nav{display:flex;gap:var(--review-space);align-items:center;flex-wrap:wrap;padding:var(--review-space) calc(var(--review-space)*3);border-bottom:1px solid var(--color-border)}
.cat-review-nav button{appearance:none;background:transparent;border:0;color:var(--color-fg-muted);border-radius:var(--radius-md,6px);padding:var(--review-space) calc(var(--review-space)*3);min-height:var(--cat-row-h,28px);font:inherit;cursor:pointer}
.cat-review-nav button[aria-current=page]{background:var(--color-bg-overlay);color:var(--color-fg)}
.cat-review-nav button:hover{color:var(--color-fg)}
.cat-review-nav button:focus-visible,.cat-review-control:focus-visible,.cat-review-search:focus-visible{outline:2px solid var(--color-accent);outline-offset:2px}
.cat-review-body{min-height:0;min-width:0;flex:1;overflow:auto;padding:calc(var(--review-space)*5) calc(var(--review-space)*6)}
.cat-review-body[data-view=diff]{display:flex;flex-direction:column;padding:0;overflow:hidden}
.cat-review-prose{max-width:72ch;margin-inline:auto}.cat-review-prose h2{font-size:var(--review-font-heading);font-weight:600;margin:calc(var(--review-space)*6) 0 calc(var(--review-space)*2)}
.cat-review-finding{border:1px solid var(--color-border);border-radius:var(--radius-md,6px);padding:calc(var(--review-space)*3);margin-block:calc(var(--review-space)*3)}
.cat-review-finding summary{cursor:pointer;font-weight:600}.cat-review-finding p{margin:calc(var(--review-space)*2) 0}
.cat-review-evidence{font:var(--review-font-caption) var(--font-mono,monospace);color:var(--color-fg-muted);overflow-wrap:anywhere}
.cat-review-stale{padding:calc(var(--review-space)*2) calc(var(--review-space)*4);color:var(--color-warning);border-bottom:1px solid var(--color-border)}
.cat-review-diff{display:flex;min-height:0;flex:1;flex-direction:column;min-width:0}
.cat-review-toolbar{display:flex;flex-shrink:0;flex-wrap:wrap;align-items:center;gap:calc(var(--review-space)*2);background:var(--color-bg-raised);padding:calc(var(--review-space)*2) calc(var(--review-space)*3);font-size:var(--review-font-small)}
.cat-review-control,.cat-review-search{border:1px solid var(--color-border);background:var(--color-bg-inset);color:var(--color-fg);border-radius:var(--radius-md,6px);padding:var(--review-space) calc(var(--review-space)*2);min-height:var(--cat-row-h,28px);font:inherit}
.cat-review-search{margin-left:auto;min-width:0}.cat-review-toggle{display:flex;align-items:center;gap:calc(var(--review-space)*1.5)}.cat-review-toggle input{accent-color:var(--color-accent)}
.cat-review-location{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--color-bg-overlay);padding:var(--review-space) calc(var(--review-space)*3);margin:0;font:var(--review-font-small) var(--font-mono,monospace)}
.cat-review-code{min-height:0;flex:1;overflow:auto}
@media(max-width:600px){.cat-review-body{padding:calc(var(--review-space)*3)}.cat-review-heading{padding:calc(var(--review-space)*2) calc(var(--review-space)*3)}.cat-review-nav{padding-inline:calc(var(--review-space)*2)}}
`;

/** Shared components carry their token-based styles into any app bundler. */
export function ReviewStyles() {
  return <style>{css}</style>;
}
