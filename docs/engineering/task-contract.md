# Work Item contract reference

A Work Item describes authorized engineering work. A Run is one execution attempt.
The Work Item persists independently of agent sessions and Run outcomes. The
authoritative schemas live in `packages/core/src/work/schema.ts`. Policy functions
live in `packages/core/src/work/policy.ts`.

## Authored contract

| Field | Meaning |
| --- | --- |
| `title`, `intent` | Nonblank task name and desired behavior. |
| `acceptanceCriteria` | Observable expected outcomes or reproducible failure evidence. At least one is required for admission. |
| `constraints` | Limits the implementation must respect. |
| `assumptions` | Explicit reversible defaults. |
| `scopePaths` | Repository-relative glob boundaries. Required for Tracks B and C. |
| `references` | Permitted source evidence. |
| `assessment` | Agent recommendation, complexity, declared risks, uncertainties, reasons, and expected paths. |
| `verification` | Strategy, optional configured profile, and outstanding manual checks. |
| `design` | Approved technical approach for Track C. |
| `sourceRevision` | Backend-assigned digest of the assessed hosted source. |

The contract schema rejects additional fields. Approval records, effective track,
state, and Run IDs are not authored contract fields. String arrays contain nonblank
values. Relative paths reject traversal and backslashes.

`assessment.proposedTrack` is optional. The configured default applies when it is
absent. Complexity is `small`, `moderate`, or `large`. Moderate complexity and
unresolved requirements require at least B. Large complexity or any declared risk
requires C. Supported risk flags are `security`, `migration`, `breaking-api`,
`production`, `sensitive-data`, `cross-service`, and `irreversible`.

The policy keeps a stricter proposed track and applies configured minimum tracks
for expected and actual changed paths. Track A becomes B when the expected
`assessment.paths` or actual changed files exceed `sdlc.fastTrackMaxFiles`
(default 10). The decision's `trackReasons` explain each escalation. An empty
risk declaration is not proof of
semantic safety. Assessment, configured path rules, and human review contribute
different evidence.

`verification.profile` selects commands from the existing project
`validationProfiles`. It adds to baseline validation. Risk rules can require
additional named profiles. `manualChecks` records unresolved human verification,
which prevents ready publication while outstanding.

`design` contains nonblank `summary`, `verification`, and `rollback` strings. It
also contains `alternatives`, `stages`, and `references` string arrays. At least
one implementation stage is required. The approved object contains the decision.
References supplement that content.

## Stored identity and approvals

Work Item identity is separate from Run identity. Hosted source identity contains
provider, issue ID, numeric issue number, URL, and source revision. A local source
contains an explicit stable key. Duplicate source intake resumes the existing
Work Item. Similar titles do not establish identity.

The complete `work.revision` is a canonical SHA-256 digest of the stored contract
and observed source.
Proposal, approval, and submission accept an expected revision. A stale expected
revision rejects the operation. Redaction precedes digest calculation.

Scope approval binds all contract content except `design`. Design approval binds
the complete contract. Adding a design preserves scope approval. Changing
acceptance, assessment, scope, verification, or assessed source invalidates
dependent approval. Approval history remains append-only.

A source edit and a contract edit are different events. Refreshing hosted source
changes the Work Item revision. It does not claim that the old contract assessed
the new issue. The Work Item needs
an explicit proposal against the refreshed source before approval or submission.

## Derived states

| State | Required next evidence |
| --- | --- |
| `needs-info` | Expected outcome, bounded scope, verification strategy, resolved material uncertainty, or current source assessment. |
| `awaiting-scope-approval` | Allowed human approval of the current scope digest. |
| `design` | Technical design, staged plan, verification, and rollback. |
| `awaiting-design-approval` | Allowed human approval of the current design digest. |
| `ready` | Admission may create or return an existing Run. |

Readiness for admission differs from delivery readiness. A Run pins the approved
contract revision and track. Execution rechecks the current contract, source,
policy, and actual changed paths. Escalation preserves evidence and prevents
unauthorized repair or publication. Completed DBOS checkpoints do not authorize
new external effects under stale approval.

See [the operating guide](sdlc.md) for intake, operator approval, recovery, and
pilot verification.

## Local usage evidence

The Store emits local `work-created`, `work-proposed`, `work-source-changed`,
`work-approved`, `work-submitted`, and `work-escalated` events. Submission records
the effective track and associated Run. These events provide pilot usage and
gate evidence through `Store.events()` without sending product telemetry.
Publication includes the Work Item identity, contract revision, intent, acceptance
criteria, and outstanding operator checks alongside review and validation evidence.
