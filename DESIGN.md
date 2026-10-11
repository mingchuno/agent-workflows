# Terminal interface design

The monitor is an operator console: make the selected subject, current state and
need for intervention clear before showing technical evidence. For shortcuts,
terminal settings and preview commands, see the [monitor guide](docs/operations.md#monitor).

## Information and layout

- Run records use two rows: reference/kind/title, then state/phase/attempt/duration.
  Disambiguate repeated attempts and mark attention with text as well as color.
- At 112 columns, show a run list beside the workspace; at 80×24, use list and
  drilldown views. Keep identity and state pinned while evidence scrolls.
- Overview leads with the failed operation, recorded evidence, next checks and
  available actions. Keep each evidence block short enough for compact terminals;
  expose full subjects and diagnostics through explicit inspection.
- Keep selection stable under polling and resize. State-change notices acknowledge
  changes without moving focus. Section selection does not change the run.

## Visual and interaction rules

Use the terminal's font, foreground and background. Bold/inverse establishes
selection; semantic colors reinforce labels. Required evidence must remain legible
without color or dim text. Use whitespace and one divider for the main view, and
a single border for dialogs. Choose ASCII UI punctuation before inserting source
values; preserve Unicode titles, paths and diagnostics.

Shortcut keys use bold inverse keycaps with semantic action color. The selected
section has an inverse label; other section labels remain plain. Separate failure
evidence, next checks and actions with blank rows, and bound overview prose to
112 cells on wide terminals. Keep full diagnostic content independently scrollable.

Stop, retry and recovery require confirmation, initially focused on Cancel.
Keep pending commands distinct from acknowledgement, and disable run actions while
the snapshot is stale. Search, help and logs own their input; nested Esc closes the
nearest layer before returning to the previous screen.

## Evidence rules

Keep delivery separate from readiness: a completed run can deliver a draft.
Free-form provider errors support possible causes, not verified diagnoses.
Do not claim checkout preservation without evidence, infer an ETA, or equate a
database connection with a live runner. Keep absent evidence distinct from empty
results. Recovery continues publication in the same run; retry starts a new run.
Closing the monitor leaves work running.
