import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { render } from "ink-testing-library";
import { LogViewer } from "../src/tui/log.js";
import { LogFile } from "../src/tui/log-file.js";
import { settle, until } from "./tui-fixtures.js";

for (const transition of [
  "replacement search",
  "switch file",
  "unmount",
] as const) {
  test(`log search cancellation survives ${transition} and late completion`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "aw-log-lifecycle-"));
    const first = join(directory, "first.log");
    const second = join(directory, "second.log");
    await writeFile(first, "needle first\n");
    await writeFile(second, "second file\n");
    const searches: {
      signal: AbortSignal;
      resolve: (match: number | undefined) => void;
    }[] = [];
    t.mock.method(
      LogFile.prototype,
      "search",
      (options: Parameters<LogFile["search"]>[0]) =>
        new Promise<number | undefined>((resolve) =>
          searches.push({ signal: options.signal, resolve }),
        ),
    );
    const view = render(
      <LogViewer
        sources={[
          { path: first, label: "first" },
          { path: second, label: "second" },
        ]}
        initial={0}
        columns={120}
        rows={30}
        onBack={() => {}}
      />,
    );
    let unmounted = false;
    try {
      await until(() => view.lastFrame()!.includes("needle first"));
      view.stdin.write("/");
      await settle();
      view.stdin.write("needle");
      await settle();
      view.stdin.write("\r");
      await until(() => searches.length === 1);
      if (transition === "replacement search") {
        view.stdin.write("n");
        await until(() => searches.length === 2);
        assert.equal(searches[0]!.signal.aborted, true);
        searches[0]!.resolve(0);
        await settle();
        assert.match(view.lastFrame()!, /Searching/);
        assert.doesNotMatch(view.lastFrame()!, /Match on line/);
        searches[1]!.resolve(undefined);
        await until(() => view.lastFrame()!.includes("No matches: needle"));
      } else {
        if (transition === "switch file") {
          view.stdin.write("\t");
          await until(() => view.lastFrame()!.includes("second file"));
        } else {
          view.unmount();
          unmounted = true;
          await settle();
        }
        assert.equal(searches[0]!.signal.aborted, true);
        const frame = view.lastFrame();
        searches[0]!.resolve(0);
        await settle();
        assert.equal(view.lastFrame(), frame);
        assert.doesNotMatch(view.lastFrame()!, /Match on line/);
      }
    } finally {
      if (!unmounted) view.unmount();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
