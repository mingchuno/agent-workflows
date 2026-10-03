# Review existing requests with a shared reviewer and stable publication identity

Issue implementation and existing-request review use separate intake and preparation
paths, then share the structured reviewer and hosting publishers under the same
exclusive project checkout queue. Review subjects pin source/target diff references;
drafts and forks are excluded, and new-head intake is opt-in.

This extends ADR 0003's retry identity rule for review-only runs: a retry still owns
a new run/execution, but retains complete findings and their publication marker when
retrying the same review target. Retaining output prevents partially published
inline comments from being paired with newly generated findings; implementation
publication recovery remains commit-backed and unchanged. Revision changes
supersede reviews instead of blocking clean projects, and providers recheck target
evidence before effects because a durable checkpoint cannot freeze a remote request.
