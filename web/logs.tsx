import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { LogPage, RecordedLog } from "../src/web/contracts.js";
import { readMonitor } from "./api.js";
import styles from "./app.module.css";

export function Logs({ runId, logs }: { runId: string; logs: RecordedLog[] }) {
  const [logId, setLogId] = useState(logs[0]?.id);
  const selected = logs.find((log) => log.id === logId) ?? logs[0];
  if (!selected) return <p>No logs recorded for this execution.</p>;
  return (
    <>
      <label>
        Recorded log
        <select
          value={selected.id}
          onChange={(event) => setLogId(event.target.value)}
        >
          {logs.map((log) => (
            <option key={log.id} value={log.id}>
              {log.label}
            </option>
          ))}
        </select>
      </label>
      <LogReader key={`${runId}:${selected.id}`} runId={runId} log={selected} />
    </>
  );
}

function LogReader({ runId, log }: { runId: string; log: RecordedLog }) {
  const viewport = useRef<HTMLElement>(null);
  const [following, setFollowing] = useState(true);
  const [raw, setRaw] = useState(false);
  const [start, setStart] = useState<number>();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<{
    query: string;
    direction: string;
    from: number;
    request: number;
  }>();
  const page = useQuery({
    queryKey: ["log", runId, log.id, start, raw, search],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ log: log.id, raw: String(raw) });
      if (start !== undefined) params.set("start", String(start));
      if (search) {
        params.set("query", search.query);
        params.set("direction", search.direction);
        params.set("start", String(Math.max(0, search.from)));
      }
      return readMonitor<LogPage>(
        `/api/runs/${encodeURIComponent(runId)}/log?${params}`,
        signal,
      );
    },
    refetchInterval: following ? 1000 : false,
  });
  const find = (direction: string) => {
    setFollowing(false);
    setSearch({
      query,
      direction,
      from:
        search && page.data?.match !== undefined
          ? page.data.match
          : (page.data?.start ?? 0),
      request: (search?.request ?? 0) + 1,
    });
  };
  const updatedAt = page.dataUpdatedAt;
  useEffect(() => {
    if (following && updatedAt && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [following, updatedAt]);
  const move = (position: number) => {
    setFollowing(false);
    setSearch(undefined);
    setStart(Math.max(0, position));
  };
  return (
    <div className={styles.logReader}>
      <div className={styles.logControls}>
        <button
          type="button"
          aria-pressed={following}
          onClick={() => {
            setFollowing(!following);
            setStart(following ? page.data?.start : undefined);
            setSearch(undefined);
          }}
        >
          {following ? "Pause following" : "Follow log"}
        </button>
        <button type="button" aria-pressed={raw} onClick={() => setRaw(!raw)}>
          {raw ? "Show formatted" : "Show raw"}
        </button>
      </div>
      <form
        className={styles.logSearch}
        onSubmit={(event) => {
          event.preventDefault();
          if (query) find("next");
        }}
      >
        <label>
          Search log
          <input
            type="search"
            maxLength={256}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button type="submit" disabled={!query || page.isFetching}>
          Find next
        </button>
        <button
          type="button"
          disabled={!query || page.isFetching}
          onClick={() => find("previous")}
        >
          Find previous
        </button>
      </form>
      {page.isError && (
        <p role="alert">
          {page.error.message}{" "}
          <button type="button" onClick={() => void page.refetch()}>
            Try again
          </button>
        </p>
      )}
      {page.isPending && <p>Loading recorded log…</p>}
      {page.data && (
        <>
          <div className={styles.logPosition}>
            <span>
              {page.data.total
                ? `Lines ${page.data.start + 1}–${page.data.start + page.data.lines.length} of ${page.data.total}`
                : "Log is empty"}
              {following ? " · following" : ""}
            </span>
            {search && (
              <span>
                {page.data.match === undefined
                  ? "No matching line"
                  : `Match at line ${page.data.match + 1}`}
              </span>
            )}
          </div>
          <section
            ref={viewport}
            className={styles.logViewport}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to focus and scroll this log region.
            tabIndex={0}
            aria-label="Log output"
          >
            <pre>
              {page.data.lines.map((line, index) => {
                const at = query
                  ? line.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
                  : -1;
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the absolute file line number is the identity of this stateless log row.
                  <div key={`${page.data!.start + index}`}>
                    <span className={styles.lineNumber}>
                      {page.data!.start + index + 1}
                    </span>
                    <span>
                      {at < 0 ? (
                        line || " "
                      ) : (
                        <>
                          {line.slice(0, at)}
                          <mark>{line.slice(at, at + query.length)}</mark>
                          {line.slice(at + query.length)}
                        </>
                      )}
                    </span>
                  </div>
                );
              })}
            </pre>
          </section>
          <div className={styles.logControls}>
            <button
              type="button"
              disabled={page.data.start === 0}
              onClick={() => move(page.data!.start - 200)}
            >
              Previous lines
            </button>
            <button
              type="button"
              disabled={
                page.data.start + page.data.lines.length >= page.data.total
              }
              onClick={() => move(page.data!.start + 200)}
            >
              Next lines
            </button>
            <button type="button" onClick={() => move(0)}>
              Beginning
            </button>
          </div>
        </>
      )}
    </div>
  );
}
