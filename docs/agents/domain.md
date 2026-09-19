# Domain docs

## Before exploring

This repository uses a single-context layout:

- `CONTEXT.md` at the repository root: domain terms and boundaries.
- `docs/adr/`: architecture decisions.

Read the context and ADRs relevant to the work. If absent, proceed
silently. The domain-modeling skill creates them lazily when terms
or decisions are resolved.

Consult existing documentation under `docs/` for the relevant
architecture, configuration, API, provider, or operational details.

## Vocabulary and decisions

Use domain terms as defined in `CONTEXT.md`. If a needed concept
is missing, reconsider the term or note the gap for domain-modeling.

Explicitly flag proposals that contradict an existing ADR, naming
the decision and explaining why it should be reconsidered.
