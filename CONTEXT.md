# Agent workflows

Local coding work progresses through issue-linked runs and explicit recovery.

## Language

**Run**:
One attempt to complete an issue through a coding workflow, with its own
outcome and recovery evidence.

**Retry admission**:
The decision to accept a new run after a failed, blocked, or cancelled run.
Competing requests cannot admit multiple active retries for the same task;
replaying an accepted command identifies its existing retry.

**Execution**:
One execution of a run, with its own outcome and failure evidence. Recovery
adds an execution to the same run; retry creates a new run.

**Publication recovery**:
Continuing a failed run at its failed publication step, reusing completed work
and preserving the branch, revision, and publication identity.
