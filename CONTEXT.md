# Agent workflows

Local coding work progresses through issue-linked runs and explicit recovery.

## Language

**Stage prompt**:
User-customizable instructions describing an agent stage's task. The workflow
supplies run evidence and enforces its result contract separately.

**Publication stage**:
The agent stage that drafts a Git commit message and the title and description
of a pull request or merge request. Creating the commit and publishing the
request are separate workflow operations.
_Avoid_: Writing stage, commit stage

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

**Execution notification**:
An operator-facing alert that reports a terminal outcome for one execution.
_Avoid_: Workflow notification, run notification

**Execution duration**:
Wall-clock time spent in one execution, excluding queue waiting before it
starts and gaps between executions awaiting publication recovery.

**Publication recovery**:
Continuing a failed run at its failed publication step, reusing completed work
and preserving the branch, revision, and publication identity.
