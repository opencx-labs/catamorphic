# 0143: Work is the home for the end-user experiences

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

The founder requested a public website for work.software covering desktop,
company brain, and mobile for everyone, alongside a framework-focused
catamorphic.ai. The existing site mixes product and embedding audiences and
advertises package installation before the installable packages are ready.

## Decision

Work is the public identity for the end-user experiences at work.software.
Catamorphic remains the open-source, embeddable framework and the core of Work.
catamorphic.ai retains short desktop and brain pages linking to Work, with no
mobile product page. Framework pages describe capabilities, link to GitHub,
and explicitly state that installable packages are coming soon.

The Work website carries forward the dark palette, orange accent, and Inter
typography, with a more spacious product presentation. This is an authorized
exception to the former requirement that every website detail follow the
desktop UI. It can inform a future desktop theme, but does not change the
app, binary names, release feeds, framework package names, or SDK contracts.

## Consequences

Product availability must stay explicit: the current Mac preview is distributed
as Catamorphic, the company brain is self-hosted, and mobile is a connected web
client. Source and documentation remain accessible on GitHub. Website visitors
can choose the end-user products or the framework without conflating them.
