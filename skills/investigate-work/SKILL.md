---
name: investigate-work
description: Investigate engineering requirements or a reported defect before proposing a Work Item contract. Use when start-work finds unclear behavior, conflicting evidence, or missing acceptance criteria.
---

# Investigate work

Read the current Work Item and [the work API](../start-work/references/work-api.md).
Preserve the source identity and current revision.

For requirements, inspect the ticket, relevant code and tests, domain context,
and prior decisions. Separate requested behavior from observed implementation.
For a defect, reproduce it in a permitted local environment, trace the failing
path, and identify a regression check. Record an unavailable reproduction as a
limitation rather than a pass.

Produce a compact investigation result with these fields.

| Field | Content |
| --- | --- |
| `findings` | Material claims with source references and whether the evidence is observed behavior, tested behavior, or a stated requirement. |
| `assumptions` | Reversible defaults and their consequences. |
| `questions` | Prioritized, deduplicated questions whose answers change acceptance, scope, safety, or feasibility. |
| `recommendedAcceptanceCriteria` | Observable outcomes, including relevant failure behavior. |
| `blockers` | Material uncertainties that prevent authorized execution. |

Investigate facts available in the repository before asking the human. Ask about
desired behavior before implementation details. Stop clarification when the
remaining choices have recorded reversible defaults or no longer change the
contract. Do not generate questions to meet a quota.

Map blockers into `assessment.uncertainties`, findings into cited references,
and defaults into `assumptions`. Return the result to
[start-work](../start-work/SKILL.md) for proposal and policy assessment. An
investigation does not grant approval or start implementation.
