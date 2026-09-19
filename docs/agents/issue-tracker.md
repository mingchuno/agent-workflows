# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `mingchuno/agent-workflows`.
Use the `gh` CLI from this repository, or pass
`--repo mingchuno/agent-workflows` explicitly.

## Conventions

- Publishing to the issue tracker means creating a GitHub issue.
- Fetch the relevant ticket with `gh issue view <number> --comments`;
  fetch its labels when triaging.
- List issues with appropriate state and label filters.
- For multiline issue bodies or comments, write the text to a
  temporary file and pass `--body-file`.
- Apply the label vocabulary in `docs/agents/triage-labels.md`.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Wayfinding

- Keep the map in one issue labelled `wayfinder:map`.
- Link child tickets as sub-issues. If unavailable, use a task list
  in the map and `Part of #<map>` in each child.
- Label children `wayfinder:<type>`, where type is `research`,
  `prototype`, `grilling`, or `task`.
- Record blockers using native issue dependencies. If unavailable,
  use `Blocked by: #<number>` and check blocker states.
- Select the first open, unassigned child in map order with no
  open blockers. Claim it by assigning the driving developer.
- On resolution, comment with the result, close the child, and
  add a summary and link to the map's Decisions-so-far.
