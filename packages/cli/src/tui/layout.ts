/** Reserve a 42-cell identity list and a 60-cell operator workspace before splitting. */
export function monitorLayout(columns: number, rows: number) {
  const wide = columns >= 112;
  const height = Math.max(1, rows - 6);
  const paneWidth = wide ? Math.max(42, Math.floor(columns * 0.42)) : columns;
  const summaryWidth = wide ? columns - paneWidth - 3 : columns;
  return {
    wide,
    height,
    paneWidth,
    summaryWidth,
    runs: { width: paneWidth, height: height - 1 },
    details: { width: columns, height: height - 5 },
    summary: { width: summaryWidth, height: height - 5 },
  };
}
