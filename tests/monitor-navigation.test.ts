import assert from "node:assert/strict";
import { test } from "node:test";
import type { Key } from "ink";
import {
  initialNavigation,
  type MonitorNavigation,
  type NavigationEvent,
  transitionNavigation,
} from "../packages/cli/src/tui/monitor-navigation.js";
import { monitorFixture } from "./tui-fixtures.js";

type Context = Extract<NavigationEvent, { type: "key" }>["context"];
const noKey = {} as Key;
function context(overrides: Partial<Context> = {}): Context {
  const { run } = monitorFixture();
  return {
    terminalIsLargeEnough: true,
    projects: [],
    runs: [run],
    projectRuns: [run],
    run,
    sessions: [],
    events: [],
    logSessions: [],
    available: { stop: true, retry: true, recover: true },
    pending: false,
    scrollMaximum: 40,
    pageSize: 10,
    ...overrides,
  };
}
function press(
  state: MonitorNavigation,
  input: string,
  key: Partial<Key> = {},
  current = context(),
) {
  return transitionNavigation(state, {
    type: "key",
    input,
    key: { ...noKey, ...key },
    context: current,
  });
}

test("search draft edits text and applies the query on return", () => {
  let state = press(initialNavigation, "/").state;
  assert.equal(state.searchDraft, "");
  state = press(state, "ab\tc").state;
  assert.equal(state.searchDraft, "abc");
  state = press(state, "", { backspace: true }).state;
  assert.equal(state.searchDraft, "ab");
  assert.equal(press(state, "", { upArrow: true }).state, state);
  assert.equal(press(state, "q").state.searchDraft, "abq");
  const applied = press(state, "", { return: true }).state;
  assert.equal(applied.query, "ab");
  assert.equal(applied.searchDraft, undefined);
  assert.equal(press(state, "", { escape: true }).state.searchDraft, undefined);
});

test("run action keys confirm only available actions", () => {
  for (const [input, kind] of [
    ["s", "stop"],
    ["r", "retry"],
    ["F", "retry-refresh"],
    ["c", "recover"],
  ] as const) {
    const modal = press(initialNavigation, input).state.modal;
    assert.equal(modal?.type === "confirmation" && modal.kind, kind);
  }
  const unavailable = context({
    available: { stop: false, retry: false, recover: false },
  });
  assert.equal(
    press(initialNavigation, "F", {}, unavailable).state.modal,
    undefined,
  );
  assert.equal(press(initialNavigation, "constructor").state.modal, undefined);
});

test("details input switches sections and scrolls without reaching the dashboard", () => {
  const details: MonitorNavigation = {
    ...initialNavigation,
    screen: "details",
  };
  assert.equal(press(details, "3").state.section, "Checks");
  assert.equal(press(details, "", { tab: true }).state.section, "Activity");
  assert.equal(
    press(details, "", { tab: true, shift: true }).state.section,
    "Actions",
  );
  assert.equal(press(details, "", { end: true }).state.offset, 40);
  assert.equal(press(details, "f").state.filter, "All");
  assert.equal(press(initialNavigation, "f").state.filter, "Attention");
});
