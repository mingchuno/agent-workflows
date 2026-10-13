---
name: Agent Workflows
description: Local operator consoles with stable context and recorded evidence
colors:
  blue: "#195f95"
  rail: "#173650"
  selected: "#e5f0f8"
  project-selected: "#294e6d"
  attention: "#805018"
  attention-ground: "#fff3dd"
  attention-line: "#d9bc89"
  success: "#246348"
  ink: "#20394e"
  muted: "#53697a"
  line: "#d4dfe8"
  paper: "#ffffff"
  ground: "#edf2f6"
  run-ground: "#f5f8fb"
  rail-ink: "#edf4fa"
  rail-muted: "#c6d9e7"
  selection-line: "#a2c7e1"
  focus: "#247cba"
typography:
  headline:
    fontFamily: '"Source Sans 3", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  title:
    fontFamily: '"Source Sans 3", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "20px"
    fontWeight: 600
  evidence-heading:
    fontFamily: '"Source Sans 3", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "18px"
    fontWeight: 600
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "14px"
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "13px"
    fontWeight: 600
  mobile-input:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "16px"
  metadata:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "12px"
  diagnostic:
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace'
    fontSize: "12px"
    lineHeight: 1.7
  configuration-json:
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace'
    fontSize: "13px"
    lineHeight: 1.8
rounded:
  control: "6px"
  evidence: "8px"
  dialog: "12px"
spacing:
  field-gap: "6px"
  control-gap: "8px"
  compact: "12px"
  small: "16px"
  medium: "18px"
  section: "20px"
  inset: "24px"
  large: "28px"
  workspace: "32px"
components:
  button:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 12px"
  button-hover:
    backgroundColor: "{colors.selected}"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 12px"
  project:
    backgroundColor: "transparent"
    textColor: "{colors.rail-ink}"
    rounded: "{rounded.control}"
    padding: "12px 10px"
  project-selected:
    backgroundColor: "{colors.project-selected}"
    textColor: "{colors.paper}"
  run:
    backgroundColor: "transparent"
    rounded: "{rounded.control}"
    padding: "15px 12px"
  run-selected:
    backgroundColor: "{colors.selected}"
  section:
    rounded: "{rounded.control}"
    padding: "8px 10px"
  section-selected:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.blue}"
  attention:
    backgroundColor: "{colors.attention-ground}"
    textColor: "{colors.attention}"
    rounded: "{rounded.evidence}"
    padding: "22px"
  diagnostic:
    backgroundColor: "{colors.ground}"
    rounded: "{rounded.control}"
    padding: "18px"
  configuration:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    typography: "{typography.configuration-json}"
    rounded: "{rounded.control}"
    padding: "18px"
---

# Design System: Agent Workflows

## Overview

**Creative North Star: "Evidence leads decisions"**

The browser monitor is a light operator console: deep blue project navigation,
a compact Run list, and a white workspace for recorded evidence. Technical report
typography and pale supporting surfaces keep inspection clear without turning
workflow state into decorative summary tiles.

This browser system is additive. The tokens above apply to the browser surface,
not terminal rendering. The incumbent terminal guidance is preserved verbatim at
the end of this file; the TUI retains the terminal's own font and colors.

**Key Characteristics:**

- Stable selection and explicit attention states.
- Compact navigation beside spacious evidence.
- System controls, report headings, and monospace technical evidence.

## Colors

The browser combines cool pale neutrals with deep blue context and restrained
semantic outcome colors. Frontmatter holds the extracted values.

### Primary

- **Blue:** links, running outcomes, timeline markers, and active section text.
- **Deep rail:** persistent project context; the lighter project selection marks
  the active project without competing with the evidence workspace.
- **Selection wash:** selected Runs, sections, and recovery evidence.
- **Focus blue:** a visible keyboard outline, distinct from selected state.

### Secondary

- **Amber attention:** failed, blocked, and cancelled outcome text; warm evidence
  panels pair attention text with a warm border and pale background.
- **Green completion:** completed outcomes and successful checks.

### Neutral

- **Ink and muted ink:** primary reading and secondary metadata.
- **Paper:** the evidence workspace and native control surfaces.
- **Ground and Run ground:** diagnostic blocks and the compact Run pane.
- **Line:** thin structural dividers; selected Runs use the selection line.
- **Rail ink and muted rail ink:** project identity and supporting rail text.

**The State Plus Text Rule.** Use outcome labels and explanatory text alongside semantic color.

## Typography

Headings h1–h3 use self-hosted Source Sans 3 at weight 600. The build imports
FontSource's Latin 600 face; its OFL license ships at
`web/public/fonts/Source-Sans-3-LICENSE.txt`. Body and native controls use the
system sans stack. Code and preformatted evidence use the system monospace stack.

Workspace titles use the headline token, become 25px below the mobile breakpoint,
and are bounded to 30ch. Configuration headings retain 28px on phones.
Rail and Run headings use 20px; evidence h3 uses 18px;
dialog headings use 24px. Labels use 13px; metadata and diagnostics use 12px.
Evidence reads at line height 1.6; diagnostics at 1.7, logs and configuration
JSON at 1.8. Configuration JSON uses its 13px monospace token. Numeric
metadata, fact lists, tables, and activity timestamps use tabular numerals.

**The Three Type Roles Rule.** Use Source Sans 3 for h1–h3, system sans for body and controls, and monospace for code and preformatted evidence.

## Layout

The desktop browser shell has three columns: a 180px project rail, a 300px Run
pane, and a flexible workspace. At widths of at least 1050px the two navigation
panes are viewport-height, sticky, and independently scrollable. At 1050px and
below, columns narrow to 150px and 250px and workspace insets reduce to 24px;
the two media queries both apply at exactly 1050px.

At 800px and below, project navigation becomes a wrapping full-width top rail
and the Run pane is 230px beside the workspace. Supporting rail labels and the
footer disappear. At 600px and below, the shell stacks; Run choices form a
horizontally scrollable row of 230–260px items. Workspace insets reduce to 16px,
activity entries stack, fact labels narrow to 105px, and section controls remain
wrapped with a 44px minimum height. Search inputs use 16px type to avoid
mobile focus zoom; coarse-pointer controls have at least 44px height.
The Run selection remains available rather
than becoming a separate browser drilldown screen.

Navigation is denser than evidence. The desktop workspace uses 32px horizontal
insets; headings and sections are separated by larger gaps than control groups.
Evidence introductions are bounded to 70ch and action descriptions to 65ch.
Configuration inspection keeps the same shell and uses 32px horizontal insets,
reducing to 16px at 760px. Its JSON surface padding reduces from 18px to 12px
at that breakpoint. Long values wrap and nested objects indent by 18px.

Tables scroll horizontally; the log viewport scrolls in both axes and is capped
at 420px high. Text diagnostics wrap; raw log lines preserve their width.

**The Evidence Priority Rule.** Explain the selected subject and need for intervention before technical detail.

## Elevation & Depth

Everyday structure is flat: pale navigation, white evidence, tonal selection,
and single-pixel dividers. Confirmation dialogs alone use a diffuse shadow
(`0 20px 80px #102b4540`) and dark translucent backdrop (`#102b4580`). When reduced
motion is not requested, opening moves the dialog upward by 8px over 160ms with
`cubic-bezier(0.16, 1, 0.3, 1)` and settles its shadow. No decorative motion is
needed to convey polling or state.

**The Flat Workspace Rule.** Use surface color and thin dividers for everyday structure; reserve the shipped shadow and backdrop for confirmation dialogs.

## Shapes

Small rounded corners distinguish controls and diagnostic blocks (control token)
from attention and recovery blocks (evidence token). Dialogs use the larger
dialog token. Timeline points are small circles (9px). Native controls use a
thin line border, while selected Runs receive a blue-toned outline. Evidence
facts and tables use dividers rather than repeated floating cards.

## Components

### Buttons and fields

Native buttons, search inputs, and selects share white surfaces, ink text, the
control radius, and 9px by 12px padding. Button hover uses the selection wash and
blue border; disabled controls use muted text on pale gray and a not-allowed
cursor. Keyboard focus uses a 3px outline with 3px offset; project buttons
use rail ink with an inward 3px offset for contrast on the blue rail. Fields retain
native
behavior; labels sit above them with a 6px gap. There is no separate filled
primary command style in this build.

### Navigation and Run selection

Projects use a text-led, borderless button on the blue rail. Selected and hovered
projects use the lighter blue surface. Run buttons carry reference and attempt,
subject, textual outcome and phase, then duration. Selection has pale blue fill
and a visible border and blue subject text. A selected Run outside the current
search or filter remains
visible with an explicit explanation. Section buttons use transparent borders;
the current section has blue text, pale selection fill, and weight 600. Phone
Run choices snap horizontally. The workspace skip link targets a focusable
main region; fixture previews explicitly label their synthetic evidence.

### Evidence containers

Attention is a warm bordered block, with preserved line breaks and readable
explanation. Recovery is a pale blue inset within the execution timeline. Facts,
checks, activity, findings, and sessions use aligned rows and thin dividers.
Diagnostics use wrapped monospace on pale ground; logs use a separately scrollable
viewport, line numbers, search highlights, and explicit follow/raw controls.

### Configuration inspection

A read-only JSON tree uses the pale diagnostic ground and control radius.
Keys use ink at weight 600; strings use green, numbers and booleans use blue,
and punctuation uses muted ink. These colors distinguish value types rather
than workflow outcomes. Whitespace and indentation preserve the hierarchy.

Disclosure controls use a geometric triangle, selection-wash hover, and a 2px
focus outline with 2px offset. They are at least 24px square on desktop and 44px
square at 760px and below. Arrow keys navigate; Enter or Space expands and collapses.
Loading, unavailable, and retained stale configuration have explicit text;
retry uses the standard command button. Inspection stays in the workspace,
without interrupting the operator in a modal.

### Confirmation dialogs

Stop, retry, retry with refreshed issue, and recovery open a native modal dialog,
bounded to 520px or the viewport minus 32px, with 30px internal padding. Cancel
receives initial focus. Pending commands and unavailable evidence disable actions;
command notices distinguish submission from runner acknowledgement and appear
at the lower viewport edge only after submission. The modal
uses the depth and motion described above.

## Do's and Don'ts

### Do:

- Do preserve selected Run identity while polling and filtering.
- Do show stale evidence and command acknowledgement as explicit text.
- Do retain native controls, visible keyboard focus, and confirmation with Cancel focused.
- Do keep absent evidence distinct from success and readiness distinct from delivery.
- Do preserve the terminal system when extending the browser monitor.

### Don't:

- Don't substitute summary tiles for recorded evidence.
- Don't use semantic color without its outcome or attention label.
- Don't hide required diagnostics behind truncated display text.
- Don't treat closing either monitor as a command to stop workflows.

---

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
