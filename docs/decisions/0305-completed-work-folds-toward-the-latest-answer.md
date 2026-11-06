# 0305 - Completed work folds toward the latest answer

- **Status:** Accepted (amends 0278)
- **Date:** 2026-11-06

## Context

Terminal notifications split a completed chat into many notes and step lists,
even with "Fold notes into steps" enabled. Background completions can wake the
agent in additional execution turns. The person asked for completed work to
collapse together so the final response stays near their last message.

## Decision

The registry's existing presentation projection folds completed steps, notes and
read task updates into one disclosure before the latest answer. This includes
automatic completed continuation turns and read command failures. Original turn
and item identities, delivery, outcomes and action targets remain unchanged.
Person messages, answered questions, unread or required attention, and unfinished
or failed turns separate reading sections. Tasks needing input and failed child
results remain visible.
Running background commands keep their current presence and exit motion before
joining folded history. Expanding the disclosure retains order, output and links.

"Keep the notes" and live display modes retain their existing behavior. This is
presentation over the shared session log, not a new conversation or inbox model.

## Consequences

One person's request reads as their message, compact work and the latest answer,
while every detail stays available. Execution turns remain independently
addressable; the setting does not suppress attention or failure outcomes.
