# TUI design

## Purpose and requirements

The monitor lets an operator follow one project's issue-linked runs, inspect
failures and logs, and request recovery without controlling the runner's lifetime.
The old view mixed diagnostics with status, lacked back navigation and displayed
one-shot log tails. The replacement uses a bounded full-screen dashboard,
scrollable details and a dedicated live log viewer.

- Keep issue number and title together. Give current outcome, phase and execution
  duration priority over configuration, full errors, paths and identifiers.
- Use section borders, focus markers, status text and restrained terminal colors.
  Respect NO_COLOR and the terminal's foreground/background palette.
- Keep contextual shortcuts at the bottom. Tab/Shift+Tab changes pane focus;
  arrows navigate within a pane. Escape returns through the current view stack.
- Support 80×24 and larger. At 110 columns, show runs, summary and sessions side
  by side; otherwise display the focused pane. Smaller terminals show a resize
  message with a working quit control.
- Confirm stop, retry and publication recovery against a captured run identity.
  Use a centered confirmation dialog, initially focused on Cancel. Tab changes
  the highlighted option; Enter activates it and Escape cancels. Show pending
  submission until runner acknowledgement. Intake pause/resume is
  immediate. Never dispatch workflow controls from logs or search input.

Help is a centered, paged dialog with one action per row. Categories separate
navigation, workflow actions, logs, search and timing. Tab/Shift+Tab or Left/Right
changes category. Escape returns to the exact previous view without resetting
its selection or scroll position. Dialogs capture keyboard input while open.

## Timing and refresh

Execution timing starts inside the first non-replayed operation, after the intake
pause gate and before eligibility/preparation or recovery safety checks. Preserve
its first terminal timestamp. Initial queue wait begins at run creation; recovery
queue wait begins at recovery admission. Total run elapsed time includes queue
waiting and gaps between executions. These are wall-clock durations, not CPU time.
No historical backfill or database reset is required for this implementation.

The monitor polls persisted state every 400 ms and advances its event cursor
rather than repeatedly reading the first 1,000 events. Default progress follows
the latest recorded step; explicit history selection remains stable. Select runs
by identity, not array position. Ignore late responses for departed selections.
Database connectivity, data freshness and command acknowledgement have distinct
meanings; runner liveness is not inferred from a successful database query.

## Boundaries

- `src/tui/index.ts`: entry point exposing `Monitor` and its `MonitorSource` contract.
- `src/tui/monitor.tsx`: screen/focus navigation, confirmations and dashboard composition.
- `src/tui/layout.ts`: shared pane dimensions for rendering and scrolling.
- `src/tui/actions.ts`: display eligibility and recovery explanations; runner
  admission remains authoritative.
- `src/tui/text.ts`: terminal sanitization and literal smart-case matching.
- `src/tui/views.tsx`, `src/tui/format.ts`: presentation, terminal-cell sizing and duration
  formatting; no workflow mutations.
- `src/tui/dialogs.tsx`: centered help and confirmation dialogs with scoped input.
- `src/tui/data.ts`: persisted queries, incremental event history and command status.
- `src/tui/log-file.ts`: sparse file index, page reads and cancellable file search.
  Decoded text is limited to requested records, not the whole file. Memory scales
  with page content, the largest record and one byte offset per 256 lines.
- `src/tui/log.tsx`: log presentation and keyboard bindings.
- `src/tui/use-log-controller.ts`: polling, search cancellation, live follow and
  viewport state. Each keyed log screen owns its controller lifetime.

Logs initially follow the file. Scrolling/search pauses follow; `f` resumes it.
`/` searches literal text in the current presentation across the selected file;
uppercase queries are case-sensitive. `n`/`N` navigates matching records with
wraparound. Escape first dismisses search, then returns to the prior run/view.
Unknown or partial JSON records remain visible rather than being discarded.
Terminal control sequences are removed before display.

## Library choice

Keep Ink and React. Ink supplies alternate-screen rendering, terminal resizing,
layout and input handling; changing renderers would not resolve the application's
state/navigation problems by itself. Use wrap-ansi and string-width for Unicode
terminal-cell layout. There is no new architectural decision requiring an ADR.

Current OpenTUI Node support requires Node 26.4+ and experimental FFI, beyond the
package's Node 22.12+ baseline. Revisit only if a concrete requirement exceeds Ink.

## Verification

Behavior tests cover selection stability, stale responses, command confirmations
and pending state, event pagination, reconnection, live logs, search/Escape,
truncation, Unicode sizing and execution timing. Existing workflow tests cover
publication recovery, cancellation and durable execution.

For interactive inspection without a database or provider calls:

```sh
node --import tsx tests/tui-demo.tsx
```

The demo uses fixture data and refuses workflow commands. Check wide/compact
layouts, terminal resizing, long content, light/dark palettes and NO_COLOR. Check
that quitting restores the terminal. Run `pnpm verify` and `pnpm pack:smoke` for
repository and packaged-command validation.

## References

- [Ink](https://github.com/vadimdemedes/ink): alternate screen, terminal-size
  hooks, layout and keyboard input.
- [Textual footer](https://textual.textualize.io/widgets/footer/): bottom-docked
  shortcuts reflecting the focused widget.
- [CLI guidelines](https://clig.dev/#output): restrained color, NO_COLOR and
  progressive disclosure; excludes full-screen TUI design.
- [OpenTUI runtime support](https://opentui.com/docs/getting-started/runtime-support/).
