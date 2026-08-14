/**
 * The stylesheet for `@catamorphic/app/ui` — every `cat-*` class the kit's
 * components render. Hosts inject it into each app guest document AFTER
 * {@link APP_BASE_CSS} (so the token vocabulary exists) and BEFORE the app's
 * own CSS (so an app can still override anything). App authors never import
 * CSS: using the components is enough.
 *
 * Rules this sheet lives by (see the desktop shell's DESIGN.md — the kit IS
 * that design system, for apps):
 * - Colors only through `var(--color-*)` tokens; radii through `--radius-*`;
 *   the one easing `--ease-standard`; fonts through `--font-sans/--font-mono`.
 *   No raw palette values, so every theme — light, dark, user-customized —
 *   comes free.
 * - Desktop density: 13px base, 4px spacing grid, 28px rows, 1px hairlines.
 * - Motion is a state-change signal on the one easing, 100–300ms; nothing
 *   loops except indeterminate progress (spinner, skeleton shimmer); exits
 *   mirror enters and play before unmount.
 * - `prefers-reduced-motion: reduce` collapses all of it to opacity-only
 *   fades of at most 50ms.
 */
export const APP_KIT_CSS = `
/* ---------------------------------------------------------------- focus */
.cat-btn:focus-visible,.cat-tab:focus-visible,.cat-switch:focus-visible,
.cat-checkbox:focus-visible,.cat-cal-day:focus-visible,.cat-cal-nav:focus-visible,
.cat-table-sort:focus-visible,.cat-datepicker-trigger:focus-visible,
.cat-datepicker-clear:focus-visible{
  outline:2px solid var(--color-accent);outline-offset:1px;
}

/* -------------------------------------------------------------- buttons */
.cat-btn{
  appearance:none;display:inline-flex;align-items:center;justify-content:center;
  gap:6px;border:1px solid transparent;border-radius:var(--radius-md);
  font:inherit;font-weight:500;white-space:nowrap;cursor:pointer;
  user-select:none;background:transparent;color:var(--color-fg);
  transition:background-color 150ms var(--ease-standard),
    border-color 150ms var(--ease-standard),color 150ms var(--ease-standard),
    opacity 150ms var(--ease-standard);
}
.cat-btn:disabled{cursor:default;opacity:.55}
/* Pending is not disabled-gray: the spinner carries the "working" signal,
   the button keeps its full color. */
.cat-btn[aria-busy="true"]:disabled{opacity:1}
.cat-btn--md{height:28px;padding:0 12px;font-size:13px}
.cat-btn--sm{height:24px;padding:0 8px;font-size:12px}
.cat-btn--primary{background:var(--color-accent);color:var(--color-accent-fg)}
.cat-btn--primary:hover:not(:disabled){
  background:color-mix(in srgb,var(--color-accent) 88%,var(--color-fg));
}
.cat-btn--ghost{border-color:var(--color-border)}
.cat-btn--ghost:hover:not(:disabled){
  background:var(--color-bg-overlay);border-color:var(--color-border-strong);
}
.cat-btn--danger{
  border-color:color-mix(in srgb,var(--color-danger) 45%,transparent);
  color:var(--color-danger);
}
.cat-btn--danger:hover:not(:disabled){
  background:color-mix(in srgb,var(--color-danger) 12%,transparent);
  border-color:var(--color-danger);
}
.cat-btn--subtle{color:var(--color-fg-muted)}
.cat-btn--subtle:hover:not(:disabled){
  background:var(--color-bg-overlay);color:var(--color-fg);
}
/* Idle and pending labels stack in one grid cell so the button reserves the
   width of the widest one — entering the loading state never reflows. */
.cat-btn-stack{display:grid;place-items:center}
.cat-btn-stack>span{grid-area:1/1;display:inline-flex;align-items:center;gap:6px}
.cat-btn-stack>span[data-hidden="true"]{visibility:hidden}

/* -------------------------------------------------- spinner & skeleton */
.cat-spinner{animation:cat-spin .8s linear infinite;flex:none}
@keyframes cat-spin{to{transform:rotate(360deg)}}
.cat-skeleton{
  position:relative;overflow:hidden;border-radius:var(--radius-sm);
  background:color-mix(in srgb,var(--color-fg) 7%,transparent);
}
.cat-skeleton::after{
  content:"";position:absolute;inset:0;
  background:linear-gradient(90deg,transparent,
    color-mix(in srgb,var(--color-fg) 6%,transparent),transparent);
  animation:cat-shimmer 1.6s linear infinite;
}
@keyframes cat-shimmer{from{translate:-100% 0}to{translate:100% 0}}

/* ---------------------------------------------------------------- field */
.cat-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.cat-field-label{font-size:12px;font-weight:500;color:var(--color-fg-muted)}
.cat-field-hint{font-size:11px;color:var(--color-fg-faint);margin:0}
.cat-field-error{font-size:11px;color:var(--color-danger);margin:0}

/* --------------------------------------------------------------- inputs */
.cat-input,.cat-textarea,.cat-select select,.cat-datepicker-trigger{
  appearance:none;font:inherit;font-size:13px;width:100%;
  color:var(--color-fg);background:var(--color-bg-inset);
  border:1px solid var(--color-border);border-radius:var(--radius-sm);
  transition:border-color 150ms var(--ease-standard),
    box-shadow 150ms var(--ease-standard);
}
.cat-input,.cat-select select{height:28px;padding:0 8px}
.cat-textarea{min-height:56px;padding:6px 8px;resize:vertical;line-height:1.45}
.cat-input::placeholder,.cat-textarea::placeholder{color:var(--color-fg-faint)}
.cat-input:focus,.cat-textarea:focus,.cat-select select:focus{
  outline:none;border-color:var(--color-accent);
  box-shadow:0 0 0 1px color-mix(in srgb,var(--color-accent) 35%,transparent);
}
.cat-input:disabled,.cat-textarea:disabled,.cat-select select:disabled,
.cat-datepicker-trigger:disabled{opacity:.55}
/* One invalid contract, kit-wide: aria-invalid gets the danger ring. */
.cat-input[aria-invalid="true"],.cat-textarea[aria-invalid="true"],
.cat-select select[aria-invalid="true"],
.cat-datepicker-trigger[aria-invalid="true"]{border-color:var(--color-danger)}
.cat-input[aria-invalid="true"]:focus,.cat-textarea[aria-invalid="true"]:focus,
.cat-select select[aria-invalid="true"]:focus{
  box-shadow:0 0 0 1px color-mix(in srgb,var(--color-danger) 35%,transparent);
}
.cat-select{position:relative;display:block;width:100%}
.cat-select select{padding-right:24px}
.cat-select::after{
  content:"";position:absolute;right:10px;top:50%;width:6px;height:6px;
  margin-top:-5px;border-right:1.5px solid var(--color-fg-muted);
  border-bottom:1.5px solid var(--color-fg-muted);rotate:45deg;
  pointer-events:none;
}

/* ---------------------------------------------------- checkbox & switch */
.cat-checkbox{
  appearance:none;flex:none;width:14px;height:14px;margin:0;cursor:pointer;
  border:1px solid var(--color-border-strong);border-radius:var(--radius-sm);
  background:var(--color-bg-inset);position:relative;vertical-align:-2px;
  transition:background-color 150ms var(--ease-standard),
    border-color 150ms var(--ease-standard);
}
.cat-checkbox:checked{background:var(--color-accent);border-color:var(--color-accent)}
.cat-checkbox:checked::after{
  content:"";position:absolute;left:4px;top:1px;width:3px;height:7px;
  border-right:1.5px solid var(--color-accent-fg);
  border-bottom:1.5px solid var(--color-accent-fg);rotate:45deg;
}
.cat-checkbox:disabled{opacity:.55;cursor:default}
.cat-switch{
  appearance:none;position:relative;flex:none;width:28px;height:16px;
  padding:0;border-radius:8px;cursor:pointer;
  border:1px solid var(--color-border-strong);background:var(--color-bg-inset);
  transition:background-color 150ms var(--ease-standard),
    border-color 150ms var(--ease-standard);
}
.cat-switch::after{
  content:"";position:absolute;top:2px;left:2px;width:10px;height:10px;
  border-radius:5px;background:var(--color-fg-muted);
  transition:translate 150ms var(--ease-standard),
    background-color 150ms var(--ease-standard);
}
.cat-switch[aria-checked="true"]{
  background:var(--color-accent);border-color:var(--color-accent);
}
.cat-switch[aria-checked="true"]::after{
  translate:12px 0;background:var(--color-accent-fg);
}
.cat-switch:disabled{opacity:.55;cursor:default}

/* ----------------------------------------------------------------- card */
.cat-card{
  background:var(--color-bg-raised);border:1px solid var(--color-border);
  border-radius:var(--radius-lg);padding:16px;min-width:0;
}
.cat-card-header{margin-bottom:12px}
.cat-card-title{margin:0;font-size:14px;font-weight:600;color:var(--color-fg)}
.cat-card-desc{margin:2px 0 0;font-size:12px;color:var(--color-fg-muted)}
.cat-card-footer{
  margin-top:12px;padding-top:12px;border-top:1px solid var(--color-border);
  display:flex;justify-content:flex-end;gap:8px;
}

/* ----------------------------------------------------------------- tabs */
.cat-tablist{
  display:flex;gap:16px;border-bottom:1px solid var(--color-border);
}
.cat-tab{
  appearance:none;position:relative;background:none;border:none;padding:6px 0 7px;
  font:inherit;font-size:13px;color:var(--color-fg-muted);cursor:pointer;
  transition:color 150ms var(--ease-standard);
}
.cat-tab:hover{color:var(--color-fg)}
.cat-tab[aria-selected="true"]{color:var(--color-fg)}
.cat-tab[aria-selected="true"]::after{
  content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;
  background:var(--color-accent);
}
.cat-tabpanel{padding-top:12px}
.cat-tabpanel:focus-visible{outline:none}

/* ---------------------------------------------------------------- badge */
.cat-badge{
  display:inline-flex;align-items:center;gap:4px;flex:none;
  font-size:11px;font-weight:500;line-height:1;padding:3px 6px;
  border-radius:var(--radius-sm);
}
.cat-badge--neutral{
  background:color-mix(in srgb,var(--color-fg) 8%,transparent);
  color:var(--color-fg-muted);
}
.cat-badge--success{
  background:color-mix(in srgb,var(--color-success) 14%,transparent);
  color:var(--color-success);
}
.cat-badge--warning{
  background:color-mix(in srgb,var(--color-warning) 14%,transparent);
  color:var(--color-warning);
}
.cat-badge--danger{
  background:color-mix(in srgb,var(--color-danger) 14%,transparent);
  color:var(--color-danger);
}
.cat-badge--info{
  background:color-mix(in srgb,var(--color-info) 14%,transparent);
  color:var(--color-info);
}

/* ------------------------------------------------- empty & error states */
.cat-empty{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:10px;padding:24px 16px;text-align:center;
}
.cat-empty-message{margin:0;font-size:13px;color:var(--color-fg-muted)}

/* ------------------------------------------------------ key/value rows */
.cat-kv-list{display:flex;flex-direction:column;min-width:0}
.cat-kv-row{
  display:flex;align-items:center;justify-content:space-between;gap:12px;
  min-height:28px;font-size:13px;min-width:0;
}
.cat-kv-list>.cat-kv-row+.cat-kv-row{border-top:1px solid var(--color-border)}
.cat-kv-label{flex-shrink:0;color:var(--color-fg-muted)}
.cat-kv-value{
  min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  text-align:right;color:var(--color-fg);
}

/* --------------------------------------------------------------- dialog */
.cat-dialog-overlay{
  position:fixed;inset:0;z-index:100;
  background:color-mix(in srgb,var(--color-bg) 55%,transparent);
  animation:cat-fade-in 220ms var(--ease-standard);
}
.cat-dialog{
  position:fixed;inset:0;z-index:101;display:grid;place-items:center;
  padding:24px;overflow:auto;
}
.cat-dialog-panel{
  background:var(--color-bg-overlay);border:1px solid var(--color-border);
  border-radius:var(--radius-lg);padding:16px;width:100%;max-width:420px;
  /* Shadows are reserved for true overlays; the scrim color is theme-neutral. */
  box-shadow:0 16px 48px -12px rgb(0 0 0 / .5);
  animation:cat-dialog-in 220ms var(--ease-standard);
}
.cat-dialog-root[data-state="closing"] .cat-dialog-overlay{
  animation:cat-fade-out 180ms var(--ease-standard) forwards;
}
.cat-dialog-root[data-state="closing"] .cat-dialog-panel{
  animation:cat-dialog-out 180ms var(--ease-standard) forwards;
}
.cat-dialog-title{margin:0 0 4px;font-size:16px;font-weight:600;color:var(--color-fg)}
.cat-dialog-desc{margin:0 0 12px;font-size:12px;color:var(--color-fg-muted)}
.cat-dialog-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
@keyframes cat-fade-in{from{opacity:0}to{opacity:1}}
@keyframes cat-fade-out{from{opacity:1}to{opacity:0}}
@keyframes cat-dialog-in{
  from{opacity:0;translate:0 4px;scale:.98}to{opacity:1;translate:0 0;scale:1}
}
@keyframes cat-dialog-out{
  from{opacity:1;translate:0 0;scale:1}to{opacity:0;translate:0 4px;scale:.98}
}

/* --------------------------------------------------- tooltip & popover */
.cat-tooltip{
  position:fixed;z-index:120;pointer-events:none;max-width:280px;
  background:var(--color-bg-overlay);border:1px solid var(--color-border);
  border-radius:var(--radius-sm);padding:4px 8px;
  font-size:11px;color:var(--color-fg);
  box-shadow:0 4px 16px -8px rgb(0 0 0 / .5);
}
.cat-popover{
  position:fixed;z-index:110;
  background:var(--color-bg-overlay);border:1px solid var(--color-border);
  border-radius:var(--radius-lg);padding:8px;
  box-shadow:0 8px 32px -12px rgb(0 0 0 / .5);
}
.cat-tooltip[data-side="top"],.cat-popover[data-side="top"]{
  animation:cat-pop-in-top 150ms var(--ease-standard);
}
.cat-tooltip[data-side="bottom"],.cat-popover[data-side="bottom"]{
  animation:cat-pop-in-bottom 150ms var(--ease-standard);
}
.cat-tooltip[data-state="closing"][data-side="top"],
.cat-popover[data-state="closing"][data-side="top"]{
  animation:cat-pop-out-top 150ms var(--ease-standard) forwards;
}
.cat-tooltip[data-state="closing"][data-side="bottom"],
.cat-popover[data-state="closing"][data-side="bottom"]{
  animation:cat-pop-out-bottom 150ms var(--ease-standard) forwards;
}
@keyframes cat-pop-in-top{from{opacity:0;translate:0 2px}to{opacity:1;translate:0 0}}
@keyframes cat-pop-out-top{from{opacity:1;translate:0 0}to{opacity:0;translate:0 2px}}
@keyframes cat-pop-in-bottom{from{opacity:0;translate:0 -2px}to{opacity:1;translate:0 0}}
@keyframes cat-pop-out-bottom{from{opacity:1;translate:0 0}to{opacity:0;translate:0 -2px}}

/* ---------------------------------------------------------------- table */
.cat-table-wrap{
  overflow:auto;border:1px solid var(--color-border);
  border-radius:var(--radius-md);background:var(--color-bg-raised);
}
.cat-table{
  width:100%;border-collapse:separate;border-spacing:0;font-size:13px;
}
.cat-table th{
  position:sticky;top:0;z-index:1;height:28px;padding:0 10px;
  background:var(--color-bg-raised);text-align:left;white-space:nowrap;
  font-size:11px;font-weight:500;color:var(--color-fg-muted);
  box-shadow:inset 0 -1px 0 var(--color-border);
}
.cat-table td{
  height:28px;padding:0 10px;color:var(--color-fg);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;max-width:0;
}
.cat-table tbody tr+tr td{border-top:1px solid var(--color-border)}
.cat-table tbody tr{transition:background-color 150ms var(--ease-standard)}
.cat-table tbody tr:hover{
  background:color-mix(in srgb,var(--color-fg) 3%,transparent);
}
.cat-table th[data-align="right"],.cat-table td[data-align="right"]{text-align:right}
.cat-table th[data-align="center"],.cat-table td[data-align="center"]{text-align:center}
.cat-table td.cat-table-state{
  max-width:none;white-space:normal;height:auto;padding:0;
}
.cat-table-sort{
  appearance:none;display:inline-flex;align-items:center;gap:4px;
  background:none;border:none;padding:0;margin:0;cursor:pointer;
  font:inherit;color:inherit;border-radius:var(--radius-sm);
}
.cat-table-sort .cat-table-arrow{
  opacity:0;transition:opacity 150ms var(--ease-standard);
  font-size:9px;line-height:1;
}
.cat-table th:hover .cat-table-arrow{opacity:.6}
.cat-table th[aria-sort] .cat-table-arrow{opacity:1;color:var(--color-accent)}
.cat-table-foot td{
  height:24px;font-size:11px;color:var(--color-fg-faint);
  border-top:1px solid var(--color-border);
}
.cat-table td .cat-skeleton{display:block}

/* ------------------------------------------------------------- calendar */
.cat-cal{width:252px;user-select:none}
.cat-cal-header{
  display:flex;align-items:center;gap:4px;margin-bottom:8px;
}
.cat-cal-title{
  flex:1;text-align:center;font-size:12px;font-weight:600;color:var(--color-fg);
}
.cat-cal-nav{
  appearance:none;display:grid;place-items:center;width:24px;height:24px;
  background:none;border:none;padding:0;border-radius:var(--radius-sm);
  color:var(--color-fg-muted);cursor:pointer;
  transition:background-color 150ms var(--ease-standard),
    color 150ms var(--ease-standard);
}
.cat-cal-nav:hover{background:var(--color-bg-overlay);color:var(--color-fg)}
.cat-cal-dowrow,.cat-cal-grid{display:grid;grid-template-columns:repeat(7,36px)}
.cat-cal-week{display:contents}
.cat-cal-dow{
  height:20px;display:grid;place-items:center;font-size:10px;
  text-transform:uppercase;letter-spacing:.04em;color:var(--color-fg-faint);
}
.cat-cal-day{
  appearance:none;position:relative;width:36px;height:28px;
  display:grid;place-items:center;background:none;border:none;padding:0;
  font:inherit;font-size:12px;color:var(--color-fg);
  border-radius:var(--radius-md);cursor:pointer;
  transition:background-color 100ms var(--ease-standard);
}
.cat-cal-day:hover{background:var(--color-bg-overlay)}
.cat-cal-day[data-outside="true"]{color:var(--color-fg-faint)}
.cat-cal-day[data-today="true"]{
  box-shadow:inset 0 0 0 1px var(--color-border-strong);
}
.cat-cal-day[data-selected-single="true"],
.cat-cal-day[data-range-start="true"],
.cat-cal-day[data-range-end="true"]{
  background:var(--color-accent);color:var(--color-accent-fg);box-shadow:none;
}
/* Range geometry: rounded caps, square middle — with first/last-column edge
   rounding so week-clipped ranges still look designed. */
.cat-cal-day[data-range-middle="true"]{
  background:color-mix(in srgb,var(--color-accent) 13%,transparent);
  border-radius:0;
}
.cat-cal-day[data-range-start="true"]{
  border-radius:var(--radius-md) 0 0 var(--radius-md);
}
.cat-cal-day[data-range-end="true"]{
  border-radius:0 var(--radius-md) var(--radius-md) 0;
}
.cat-cal-day[data-range-start="true"][data-range-end="true"]{
  border-radius:var(--radius-md);
}
.cat-cal-grid .cat-cal-day:nth-child(7n+1)[data-range-middle="true"]{
  border-top-left-radius:var(--radius-md);
  border-bottom-left-radius:var(--radius-md);
}
.cat-cal-grid .cat-cal-day:nth-child(7n)[data-range-middle="true"]{
  border-top-right-radius:var(--radius-md);
  border-bottom-right-radius:var(--radius-md);
}
.cat-cal-grid .cat-cal-day:nth-child(7n+1)[data-range-end="true"],
.cat-cal-grid .cat-cal-day:nth-child(7n)[data-range-start="true"]{
  border-radius:var(--radius-md);
}
.cat-cal-footer{
  display:flex;align-items:center;justify-content:space-between;margin-top:8px;
}

/* ---------------------------------------------------------- date picker */
.cat-datepicker{position:relative;display:block;width:100%}
.cat-datepicker-trigger{
  display:inline-flex;align-items:center;gap:8px;height:28px;padding:0 8px;
  text-align:left;cursor:pointer;
}
.cat-datepicker-trigger>svg{flex:none;color:var(--color-fg-muted)}
.cat-datepicker-trigger>span{
  flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.cat-datepicker-trigger[data-empty="true"]>span{color:var(--color-fg-faint)}
.cat-datepicker[data-clearable="true"] .cat-datepicker-trigger{padding-right:26px}
.cat-datepicker-clear{
  appearance:none;position:absolute;right:3px;top:50%;translate:0 -50%;
  display:grid;place-items:center;width:20px;height:20px;
  background:none;border:none;padding:0;border-radius:var(--radius-sm);
  color:var(--color-fg-faint);cursor:pointer;
  transition:color 150ms var(--ease-standard),
    background-color 150ms var(--ease-standard);
}
.cat-datepicker-clear:hover{background:var(--color-bg-overlay);color:var(--color-fg)}

/* ---------------------------------------------------------- scroll hint */
.cat-scrollhint{position:relative;--cat-fade-color:var(--color-bg-raised)}
.cat-scrollhint-viewport{overflow:auto;max-height:inherit;min-width:0}
.cat-scrollhint-fade{
  position:absolute;z-index:2;pointer-events:none;opacity:0;
  transition:opacity 200ms var(--ease-standard);
}
.cat-scrollhint-fade[data-visible="true"]{opacity:1}
.cat-scrollhint-fade[data-edge="top"]{
  top:0;left:0;right:0;height:24px;
  background:linear-gradient(to bottom,var(--cat-fade-color),transparent);
}
.cat-scrollhint-fade[data-edge="bottom"]{
  bottom:0;left:0;right:0;height:24px;
  background:linear-gradient(to top,var(--cat-fade-color),transparent);
}
.cat-scrollhint-fade[data-edge="left"]{
  left:0;top:0;bottom:0;width:24px;
  background:linear-gradient(to right,var(--cat-fade-color),transparent);
}
.cat-scrollhint-fade[data-edge="right"]{
  right:0;top:0;bottom:0;width:24px;
  background:linear-gradient(to left,var(--cat-fade-color),transparent);
}

/* ------------------------------------------------------- reduced motion */
@media (prefers-reduced-motion:reduce){
  .cat-dialog-overlay,.cat-dialog-panel,
  .cat-tooltip[data-side],.cat-popover[data-side]{
    animation:cat-fade-in 50ms var(--ease-standard);
  }
  .cat-dialog-root[data-state="closing"] .cat-dialog-overlay,
  .cat-dialog-root[data-state="closing"] .cat-dialog-panel,
  .cat-tooltip[data-state="closing"][data-side],
  .cat-popover[data-state="closing"][data-side]{
    animation:cat-fade-out 50ms var(--ease-standard) forwards;
  }
  .cat-skeleton::after{animation:none}
  .cat-btn,.cat-tab,.cat-input,.cat-textarea,.cat-select select,
  .cat-checkbox,.cat-switch,.cat-switch::after,.cat-cal-day,.cat-cal-nav,
  .cat-table tbody tr,.cat-table-sort .cat-table-arrow,.cat-scrollhint-fade,
  .cat-datepicker-clear{transition-duration:1ms}
}
`;
