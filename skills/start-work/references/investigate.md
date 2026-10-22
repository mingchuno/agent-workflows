# Investigate before asking

Use when requirements are unclear, evidence conflicts, or a defect needs a root
cause. On the delegated protocol, preserve the Work Item's source identity and
revision.

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

Map blockers into `assessment.uncertainties`, findings and settled decisions
into `context` with their sources in `references`, and defaults into
`assumptions`, then return to [start-work](../SKILL.md) step 3.
An investigation does not grant approval or start implementation.
