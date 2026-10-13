export const runSections = [
  "Overview",
  "Activity",
  "Checks",
  "Executions",
  "Diagnostics",
  "Technical",
  "Actions",
] as const;
export type RunSection = (typeof runSections)[number];
