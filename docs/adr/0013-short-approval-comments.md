# Approve on the issue with a short contract code

Provider approval required an allowed human to paste
`agent-workflows approve WORK_ID GATE REVISION`, with a UUID and a 64-character
Work Item revision that appeared nowhere on the issue. The revision cannot be
printed there: it covers the issue body, so printing it would change it
(ADR 0011).

A short comment `/approve GATE CODE` also approves. `CODE` is the first twelve
hex characters of the gate's contract digest without the assessed source
revision, so the published contract can print the exact comment. The Work Item
is the one whose contract the issue carries. Synchronization accepts a short
comment only when the issue still shows the current contract, the issue
revision is the one the Work Item observed, and the comment was posted after
the Work Item last changed. The last rule keeps ADR 0009's guarantee that a
source edit invalidates earlier authorization, even when reassessment leaves
the contract text unchanged.

Approval still binds what the approver can read. The code is a name for the
contract, not a secret; authority comes from the host-authenticated allowlisted
author. Comparing host comment time with the local clock can ignore a comment
posted within the skew after publication; reposting fixes it. The full form
remains valid.
