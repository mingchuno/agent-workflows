import type { LogPage } from "../src/web/contracts.js";

type Search = {
  query: string;
  direction: "next" | "previous";
  from: number;
  request: number;
};
export type LogNavigation =
  | { mode: "follow" }
  | { mode: "page"; start?: number }
  | { mode: "search"; start?: number; search: Search };
export type LogNavigationAction =
  | { type: "toggle-follow"; pageStart?: number }
  | { type: "move"; start: number }
  | {
      type: "search";
      query: string;
      direction: Search["direction"];
      page?: Pick<LogPage, "start" | "match">;
    };

export function navigateLog(
  state: LogNavigation,
  action: LogNavigationAction,
): LogNavigation {
  switch (action.type) {
    case "toggle-follow":
      return state.mode === "follow"
        ? { mode: "page", start: action.pageStart }
        : { mode: "follow" };
    case "move":
      return { mode: "page", start: Math.max(0, action.start) };
    case "search":
      return {
        mode: "search",
        start: state.mode === "follow" ? undefined : state.start,
        search: {
          query: action.query,
          direction: action.direction,
          from:
            state.mode === "search" && action.page?.match !== undefined
              ? action.page.match
              : (action.page?.start ?? 0),
          request: state.mode === "search" ? state.search.request + 1 : 1,
        },
      };
  }
}
