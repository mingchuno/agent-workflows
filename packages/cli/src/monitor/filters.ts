export const runFilters = [
  "All",
  "Attention",
  "Active",
  "Queued",
  "Finished",
] as const;
export type RunFilter = (typeof runFilters)[number];
