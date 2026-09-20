/** Pane content sizes shared by rendering and keyboard scrolling. */
export function monitorLayout(columns: number, rows: number) {
  const wide = columns >= 110;
  const height = Math.max(1, rows - 6);
  const paneWidth = wide ? Math.floor(columns * 0.43) : columns;
  const summaryWidth = wide ? columns - paneWidth : columns;
  const summaryPanelHeight = wide ? height - 6 : height;
  const sessionsPanelHeight = wide ? 6 : height;
  return {
    wide,
    height,
    paneWidth,
    summaryWidth,
    summaryPanelHeight,
    sessionsPanelHeight,
    details: { width: columns - 4, height: height - 3 },
    runs: { width: paneWidth - 4, height: height - 3 },
    summary: { width: summaryWidth - 4, height: summaryPanelHeight - 3 },
    sessions: { width: summaryWidth - 4, height: sessionsPanelHeight - 3 },
  };
}
