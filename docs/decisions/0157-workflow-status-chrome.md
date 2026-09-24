# 0157 — Workflow tabs: status chrome and a panel that follows its subject

- **Status:** Accepted
- **Date:** 2026-09-24
- **Amends:** 0097 (the desktop inspector's layout and the packaged toolbar)

## Context

A workflow tab repeated its name under the tab strip, beside Save,
Automate, Run and a panel toggle that looked like the window's right-sidebar
button. The inspector was always open with Details, Code and Runs tabs, even
when nothing was being inspected. "Automate" appeared on every workflow,
although automatic runs only exist for workflows that declare triggers. Tabs
and chat chips opened from links showed the export identifier instead of the
workflow's name. The packaged editor carried a toolbar with emoji labels and
an AI bar that rewrote code outside the agent chat.

## Decision

The tab names the workflow; the workflow surface does not repeat it. Tabs,
rail chips and chat link chips use the display name.

State and actions float in the canvas's top-right corner, as a chat tab's do:
a status trigger whose popover holds the overview (description, saved and
preview state, inputs, how it starts, automatic runs, source) and actions,
a code toggle, Save only while a draft exists, and Run. Problems (a parse
error, a file changed under a draft) show on the trigger; decisions only the
user can make open the popover once.

The side panel opens only for a subject and closes with it: a selected step,
code, a run, automatic runs, or a change request. Each has a title and a
close button; there is no panel toggle and no tab strip. Selecting a step
shows it, clearing the selection closes it, Escape closes it, and while code
is open the editor follows the selection instead. A change request follows
the selection too.

Automatic runs appear only when the code declares triggers, as a row in the
status popover, and both runs and automatic runs lead with publishing when
the workflow is not in the published version. Publishing records saved
changes and publishes in one action.

A change request sends the person's words with the file and the workflow or
step as context pills. Its chat opens folded so the graph stays in view while
the agent works.

In the packages, the canvas only selects; `rightPanelOpenAtom`,
`activePanelTabAtom`, `panelVisibilityAtom`, `Toolbar`, `AIBar` and
`aiLoadingAtom` are removed. `WorkflowEditor` renders replaceable corner
controls and passes its inspector slot the selected step and `close`. Graph
identity comes from each laid-out node's own data, so an insert that reuses a
parser id moves the neighbor instead of swapping them; arrivals fade in after
departures clear. The canvas pans (never zooms) to keep the selection and
newly added steps in view, and refits only when a resize leaves nothing
visible. Nodes use neutral surfaces with the accent reserved for selection;
edges are solid and still.

We considered keeping a collapsed toggle beside the status trigger, and a
separate automation tab. Both kept chrome that has no subject most of the
time.

## Consequences

Embedders using the removed atoms, `Toolbar` or `AIBar` compose corner
controls through `renderControls` and derive inspector visibility from the
selection. Code, runs and automatic runs are one click from the corner;
step details need no click beyond the step. Hosts that reserve the canvas
corner (sidebar header placement, floating surfaces) offset the controls.
