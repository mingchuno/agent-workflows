import { screenChromeRows } from "./constants.js";

const panelHorizontalChrome = 4;
const panelVerticalChrome = 3;

/** Pane content sizes shared by rendering and keyboard scrolling. */
export function monitorLayout(columns: number, rows: number) {
  const wide = columns >= 110;
  const height = Math.max(1, rows - screenChromeRows);
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
    details: {
      width: columns - panelHorizontalChrome,
      height: height - panelVerticalChrome,
    },
    runs: {
      width: paneWidth - panelHorizontalChrome,
      height: height - panelVerticalChrome,
    },
    summary: {
      width: summaryWidth - panelHorizontalChrome,
      height: summaryPanelHeight - panelVerticalChrome,
    },
    sessions: {
      width: summaryWidth - panelHorizontalChrome,
      height: sessionsPanelHeight - panelVerticalChrome,
    },
  };
}
